// deno-lint-ignore-file no-import-prefix -- tests pin the exact JSR/npm artifacts.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { loadEmbeddedRobotoFonts } from "../_shared/core/pdf-fonts.ts";
import {
  paginatePdfRows,
  sanitizePdfText,
} from "../_shared/core/pdf-layout.ts";
import { renderPurchaseOrderPdf } from "../_shared/core/pdf-renderer.ts";
import {
  executePurchaseOrderPdfPipeline,
  PdfPipelineError,
  type PurchaseOrderPdfDocument,
  type PurchaseOrderPdfRepository,
} from "../_shared/core/pdf-service.ts";

function purchaseOrder(lineCount: number): PurchaseOrderPdfDocument {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    po_number: `PO-2026-${String(lineCount).padStart(4, "0")}`,
    supplier_name: "Šviežios daržovės 🙂",
    status: "approved",
    currency: "EUR",
    subtotal_minor: lineCount * 100,
    tax_total_minor: lineCount * 21,
    withholding_minor: 0,
    total_minor: lineCount * 121,
    created_at: "2026-07-21T00:00:00.000Z",
    approved_at: "2026-07-21T01:00:00.000Z",
    restaurants: [{ name: "Ресторан Вильнюс" }],
    restaurant_name: "Ресторан Вильнюс",
    generated_at: "2026-07-21T12:34:56.000Z",
    lines: Array.from({ length: lineCount }, (_, index) => ({
      description: `Помидоры ${index + 1} 🙂`,
      category_name: "Daržovės",
      quantity: "1",
      unit: "kg",
      unit_price_minor: 100,
      line_subtotal_minor: 100,
      tax_minor: 21,
      line_total_minor: 121,
      tax_detail: { rate_bps: 2_100 },
    })),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stableBuffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBuffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("embedded Roboto payloads match the pinned npm source", async () => {
  const fonts = await loadEmbeddedRobotoFonts();
  assertEquals(fonts.regular.byteLength, 159_108);
  assertEquals(fonts.bold.byteLength, 159_900);
  assertEquals(
    await sha256Hex(fonts.regular),
    "15256405ecb0d880678833a582760efad538ab2932318b52c8105b267d159459",
  );
  assertEquals(
    await sha256Hex(fonts.bold),
    "4aaf8c5b661a386998c2e70cf2b87e2440f5404e0b8fd81164f0413fb3435ec6",
  );
});

Deno.test("Roboto preserves Lithuanian and Cyrillic and safely replaces emoji", async () => {
  const bytes = await renderPurchaseOrderPdf(purchaseOrder(1));
  const loaded = await PDFDocument.load(bytes);
  assertEquals(loaded.getPageCount(), 1);
  assert(bytes.byteLength > 10_000);

  const fontBytes = await loadEmbeddedRobotoFonts();
  const fontDocument = await PDFDocument.create();
  const fontkit = (await import("npm:@pdf-lib/fontkit@1.1.1")).default;
  fontDocument.registerFontkit(fontkit);
  const font = await fontDocument.embedFont(fontBytes.regular);
  const supported = new Set(font.getCharacterSet());
  assertEquals(
    sanitizePdfText("Šviežios daržovės / Поставщик 🙂", supported),
    "Šviežios daržovės / Поставщик ?",
  );
});

for (const [lineCount, expectedPages] of [[1, 1], [40, 2], [250, 9]] as const) {
  Deno.test(`renderer paginates ${lineCount} lines into ${expectedPages} page(s)`, async () => {
    assertEquals(
      paginatePdfRows(Array.from({ length: lineCount })).length,
      expectedPages,
    );
    const bytes = await renderPurchaseOrderPdf(purchaseOrder(lineCount));
    const loaded = await PDFDocument.load(bytes);
    assertEquals(loaded.getPageCount(), expectedPages);
    for (const page of loaded.getPages()) {
      assertEquals(page.getWidth(), 595.28);
      assertEquals(page.getHeight(), 841.89);
    }
  });
}

Deno.test("pipeline rejects line-query and bookkeeping failures", async () => {
  const document = purchaseOrder(1);
  const base: PurchaseOrderPdfRepository = {
    fetchPurchaseOrder: () => Promise.resolve({ data: document, error: null }),
    fetchPurchaseOrderLines: () =>
      Promise.resolve({ data: document.lines, error: null }),
    markPdfGenerated: () =>
      Promise.resolve({ data: { id: document.id }, error: null }),
  };

  await assertRejects(
    () =>
      executePurchaseOrderPdfPipeline({
        poId: document.id,
        repository: {
          ...base,
          fetchPurchaseOrderLines: () =>
            Promise.resolve({ data: null, error: new Error("db") }),
        },
        render: renderPurchaseOrderPdf,
      }),
    PdfPipelineError,
    "Could not load all purchase-order lines",
  );

  const updateError = await assertRejects(
    () =>
      executePurchaseOrderPdfPipeline({
        poId: document.id,
        repository: {
          ...base,
          markPdfGenerated: () =>
            Promise.resolve({ data: null, error: new Error("write") }),
        },
        render: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      }),
    PdfPipelineError,
  );
  assertEquals(updateError.code, "pdf_bookkeeping_failed");
});
