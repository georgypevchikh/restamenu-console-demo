/**
 * POST { poId } -> application/pdf
 *
 * The caller's JWT/RLS authorises both document queries. Rendering uses bundled
 * Unicode fonts and deterministic pagination; no runtime font/network fetch is
 * involved. A PDF is returned only after every query and the bookkeeping update
 * succeeds, so an incomplete document is never presented as a successful 200.
 */

import { resolveCaller, serviceClient, userClient } from "../_shared/db.ts";
import { errorJson, internalError } from "../_shared/http.ts";
import { pdfContentDisposition } from "../_shared/core/pdf-layout.ts";
import { renderPurchaseOrderPdf } from "../_shared/core/pdf-renderer.ts";
import {
  executePurchaseOrderPdfPipeline,
  PdfPipelineError,
  type PdfPurchaseOrderLineRecord,
  type PdfPurchaseOrderRecord,
  type PurchaseOrderPdfRepository,
} from "../_shared/core/pdf-service.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return noStore(errorJson(405, "method_not_allowed"));
    }

    const caller = await resolveCaller(req);
    if (!caller) return noStore(errorJson(401, "not_authenticated"));
    if (caller.role !== "manager") {
      return noStore(errorJson(403, "manager_required"));
    }

    const body = await req.json().catch(() => null) as
      | { poId?: unknown }
      | null;
    if (typeof body?.poId !== "string" || !UUID_PATTERN.test(body.poId)) {
      return noStore(errorJson(400, "bad_request", "poId must be a UUID"));
    }

    const asUser = userClient(req);
    const repository: PurchaseOrderPdfRepository = {
      async fetchPurchaseOrder(poId) {
        const { data, error } = await asUser
          .from("purchase_orders")
          .select(
            "id, po_number, supplier_name, status, currency, subtotal_minor, tax_total_minor, withholding_minor, total_minor, created_at, approved_at, restaurants(name)",
          )
          .eq("id", poId)
          .eq("restaurant_id", caller.restaurantId)
          .maybeSingle();
        return {
          data: data as unknown as PdfPurchaseOrderRecord | null,
          error,
        };
      },
      async fetchPurchaseOrderLines(poId) {
        const { data, error } = await asUser
          .from("purchase_order_lines")
          .select(
            "description, category_name, quantity, unit, unit_price_minor, line_subtotal_minor, tax_minor, line_total_minor, tax_detail",
          )
          .eq("purchase_order_id", poId)
          .eq("restaurant_id", caller.restaurantId)
          .order("description");
        return {
          data: data as unknown as PdfPurchaseOrderLineRecord[] | null,
          error,
        };
      },
      async markPdfGenerated(poId, generatedAt) {
        const { data, error } = await serviceClient()
          .from("purchase_orders")
          .update({ pdf_generated_at: generatedAt })
          .eq("id", poId)
          .eq("restaurant_id", caller.restaurantId)
          .select("id")
          .maybeSingle();
        return { data: data as { id: string } | null, error };
      },
    };

    const result = await executePurchaseOrderPdfPipeline({
      poId: body.poId,
      repository,
      render: renderPurchaseOrderPdf,
    });
    const bytes = new Uint8Array(result.bytes).buffer;

    return noStore(
      new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": pdfContentDisposition(result.poNumber),
          "Content-Length": String(result.bytes.byteLength),
        },
      }),
    );
  } catch (error) {
    if (error instanceof PdfPipelineError) {
      console.error(`[generate-po-pdf:${error.code}]`, error.cause ?? error);
      if (error.status < 500) {
        return noStore(errorJson(error.status, error.code, error.message));
      }
      return noStore(errorJson(500, "internal_error"));
    }
    return noStore(internalError("generate-po-pdf", error));
  }
});
