import { describe, expect, it, vi } from "vitest";
import {
  executePurchaseOrderPdfPipeline,
  type PdfPurchaseOrderLineRecord,
  type PdfPurchaseOrderRecord,
  type PurchaseOrderPdfRepository,
} from "../supabase/functions/_shared/core/pdf-service.ts";

const PO: PdfPurchaseOrderRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  po_number: "PO-2026-0002",
  supplier_name: "Šviežios daržovės",
  status: "approved",
  currency: "EUR",
  subtotal_minor: 1_000,
  tax_total_minor: 210,
  withholding_minor: 0,
  total_minor: 1_210,
  created_at: "2026-07-21T00:00:00.000Z",
  approved_at: "2026-07-21T01:00:00.000Z",
  restaurants: [{ name: "Ресторан Вильнюс" }],
};

const LINE: PdfPurchaseOrderLineRecord = {
  description: "Помидоры",
  category_name: "Daržovės",
  quantity: "2",
  unit: "kg",
  unit_price_minor: 500,
  line_subtotal_minor: 1_000,
  tax_minor: 210,
  line_total_minor: 1_210,
  tax_detail: { rate_bps: 2_100 },
};

function repository(overrides: Partial<PurchaseOrderPdfRepository> = {}) {
  return {
    fetchPurchaseOrder: vi.fn(async () => ({ data: PO, error: null })),
    fetchPurchaseOrderLines: vi.fn(async () => ({ data: [LINE], error: null })),
    markPdfGenerated: vi.fn(async () => ({ data: { id: PO.id }, error: null })),
    ...overrides,
  } satisfies PurchaseOrderPdfRepository;
}

describe("purchase-order PDF orchestration", () => {
  it("returns bytes only after queries, render, and bookkeeping all succeed", async () => {
    const repo = repository();
    const render = vi.fn(async (document) => {
      expect(document.restaurant_name).toBe("Ресторан Вильнюс");
      expect(document.generated_at).toBe("2026-07-21T12:34:56.000Z");
      expect(document.lines).toEqual([LINE]);
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    });

    const result = await executePurchaseOrderPdfPipeline({
      poId: PO.id,
      repository: repo,
      render,
      now: () => new Date("2026-07-21T12:34:56.000Z"),
    });

    expect(result.filename).toBe("PO-2026-0002.pdf");
    expect(result.bytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(repo.markPdfGenerated).toHaveBeenCalledWith(
      PO.id,
      "2026-07-21T12:34:56.000Z",
    );
  });

  it("aborts before render when the PO query errors", async () => {
    const repo = repository({
      fetchPurchaseOrder: vi.fn(async () => ({ data: null, error: new Error("db down") })),
    });
    const render = vi.fn();

    await expect(
      executePurchaseOrderPdfPipeline({ poId: PO.id, repository: repo, render }),
    ).rejects.toMatchObject({ code: "po_query_failed", status: 500 });
    expect(render).not.toHaveBeenCalled();
    expect(repo.markPdfGenerated).not.toHaveBeenCalled();
  });

  it("distinguishes not-found from a failed PO query", async () => {
    const repo = repository({
      fetchPurchaseOrder: vi.fn(async () => ({ data: null, error: null })),
    });

    await expect(
      executePurchaseOrderPdfPipeline({ poId: PO.id, repository: repo, render: vi.fn() }),
    ).rejects.toMatchObject({ code: "po_not_found", status: 404 });
  });

  it("aborts before render when the lines query errors or returns no rows", async () => {
    for (const linesResult of [
      { data: null, error: new Error("line query failed") },
      { data: [], error: null },
    ]) {
      const repo = repository({
        fetchPurchaseOrderLines: vi.fn(async () => linesResult),
      });
      const render = vi.fn();

      await expect(
        executePurchaseOrderPdfPipeline({ poId: PO.id, repository: repo, render }),
      ).rejects.toMatchObject({
        code: linesResult.error ? "po_lines_query_failed" : "po_lines_missing",
      });
      expect(render).not.toHaveBeenCalled();
      expect(repo.markPdfGenerated).not.toHaveBeenCalled();
    }
  });

  it("does not mark generation when rendering fails", async () => {
    const repo = repository();
    const render = vi.fn(async () => {
      throw new Error("font failure");
    });

    await expect(
      executePurchaseOrderPdfPipeline({ poId: PO.id, repository: repo, render }),
    ).rejects.toMatchObject({ code: "pdf_render_failed", status: 500 });
    expect(repo.markPdfGenerated).not.toHaveBeenCalled();
  });

  it("never returns rendered bytes when the bookkeeping update fails", async () => {
    const repo = repository({
      markPdfGenerated: vi.fn(async () => ({ data: null, error: new Error("write failed") })),
    });
    const render = vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    await expect(
      executePurchaseOrderPdfPipeline({ poId: PO.id, repository: repo, render }),
    ).rejects.toMatchObject({ code: "pdf_bookkeeping_failed", status: 500 });
    expect(render).toHaveBeenCalledOnce();
  });
});
