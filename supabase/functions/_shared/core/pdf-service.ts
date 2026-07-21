/** Database-independent orchestration for loading, rendering, and recording a PDF. */

import { sanitizePdfFilename } from "./pdf-layout.ts";

export interface PdfPurchaseOrderRecord {
  id: string;
  po_number: string;
  supplier_name: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  tax_total_minor: number;
  withholding_minor: number;
  total_minor: number;
  created_at: string;
  approved_at: string | null;
  restaurants: unknown;
}

export interface PdfPurchaseOrderLineRecord {
  description: string;
  category_name: string | null;
  quantity: string | number;
  unit: string | null;
  unit_price_minor: number;
  line_subtotal_minor: number;
  tax_minor: number;
  line_total_minor: number;
  tax_detail: unknown;
}

export interface PurchaseOrderPdfDocument extends PdfPurchaseOrderRecord {
  restaurant_name: string;
  lines: PdfPurchaseOrderLineRecord[];
  generated_at: string;
}

export interface PdfQueryResult<T> {
  data: T;
  error: unknown | null;
}

export interface PurchaseOrderPdfRepository {
  fetchPurchaseOrder(
    poId: string,
  ): Promise<PdfQueryResult<PdfPurchaseOrderRecord | null>>;
  fetchPurchaseOrderLines(
    poId: string,
  ): Promise<PdfQueryResult<PdfPurchaseOrderLineRecord[] | null>>;
  markPdfGenerated(
    poId: string,
    generatedAt: string,
  ): Promise<PdfQueryResult<{ id: string } | null>>;
}

export interface PdfPipelineResult {
  bytes: Uint8Array;
  filename: string;
  poNumber: string;
}

export class PdfPipelineError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PdfPipelineError";
  }
}

export type PurchaseOrderPdfRenderer = (
  document: PurchaseOrderPdfDocument,
) => Promise<Uint8Array>;

function restaurantNameFromRelation(relation: unknown): string {
  const value = Array.isArray(relation) ? relation[0] : relation;
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return "Restaurant";
}

export async function executePurchaseOrderPdfPipeline(options: {
  poId: string;
  repository: PurchaseOrderPdfRepository;
  render: PurchaseOrderPdfRenderer;
  now?: () => Date;
}): Promise<PdfPipelineResult> {
  const { poId, repository, render } = options;

  const poResult = await repository.fetchPurchaseOrder(poId);
  if (poResult.error) {
    throw new PdfPipelineError(
      "po_query_failed",
      500,
      "Could not load the purchase order",
      { cause: poResult.error },
    );
  }
  if (!poResult.data) {
    throw new PdfPipelineError("po_not_found", 404, "Purchase order not found");
  }

  const linesResult = await repository.fetchPurchaseOrderLines(poId);
  if (linesResult.error || !linesResult.data) {
    throw new PdfPipelineError(
      "po_lines_query_failed",
      500,
      "Could not load all purchase-order lines",
      { cause: linesResult.error },
    );
  }
  if (linesResult.data.length === 0) {
    throw new PdfPipelineError(
      "po_lines_missing",
      409,
      "A purchase-order PDF requires at least one line",
    );
  }

  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  let bytes: Uint8Array;
  try {
    bytes = await render({
      ...poResult.data,
      restaurant_name: restaurantNameFromRelation(poResult.data.restaurants),
      lines: linesResult.data,
      generated_at: generatedAt,
    });
  } catch (error) {
    throw new PdfPipelineError(
      "pdf_render_failed",
      500,
      "Could not render PDF",
      {
        cause: error,
      },
    );
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new PdfPipelineError(
      "pdf_render_failed",
      500,
      "Renderer returned an empty PDF",
    );
  }

  const updateResult = await repository.markPdfGenerated(
    poResult.data.id,
    generatedAt,
  );
  if (updateResult.error || !updateResult.data) {
    throw new PdfPipelineError(
      "pdf_bookkeeping_failed",
      500,
      "PDF was rendered but generation could not be recorded",
      { cause: updateResult.error },
    );
  }

  return {
    bytes,
    filename: sanitizePdfFilename(poResult.data.po_number),
    poNumber: poResult.data.po_number,
  };
}
