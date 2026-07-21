"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import { invokeEdge } from "@/lib/edge";
import {
  OrderInputError,
  parseOrderLines,
  validateSupplierName,
  type OrderLineDraft,
} from "@/lib/order-input";

export type { OrderLineDraft } from "@/lib/order-input";

interface ActionResult {
  error?: string;
}

/**
 * Draft → priced → persisted, in three hops that each enforce their own
 * boundary: calculate-tax reads rule sets through the caller's JWT, the
 * create_purchase_order RPC re-checks manager/entitlement/arithmetic in
 * Postgres, and RLS scopes every read along the way.
 */
export async function createOrder(
  formData: FormData,
): Promise<ActionResult | void> {
  const linesRaw = String(formData.get("lines_json") ?? "[]");

  let supplierName: string;
  let lines: OrderLineDraft[];
  try {
    supplierName = validateSupplierName(formData.get("supplier_name"));
    lines = parseOrderLines(linesRaw);
  } catch (error) {
    if (error instanceof OrderInputError) return { error: error.message };
    return { error: "Invalid order data." };
  }

  const { supabase, active } = await requireRestaurantContext();
  const calc = await invokeEdge("calculate-tax", { lines });
  if (calc.status !== 200 || !calc.json) {
    const detail =
      (calc.json?.message as string) ??
      (calc.json?.error as string) ??
      calc.status;
    return { error: `Tax calculation failed: ${detail}` };
  }

  const result = calc.json as {
    lines: Array<{
      product_id: string | null;
      request_id: string | null;
      description: string;
      category_name: string | null;
      quantity_milli: number;
      unit: string | null;
      unit_price_minor: number;
      line_subtotal_minor: number;
      tax_minor: number;
      line_total_minor: number;
      tax_detail: { rule_name: string; rate_bps: number };
    }>;
    subtotal_minor: number;
    tax_total_minor: number;
    withholding_minor: number;
    total_minor: number;
    rule_set: { id: string; version: number };
    trace: unknown[];
  };

  const { data: poId, error } = await supabase.rpc("create_purchase_order", {
    p_restaurant_id: active.id,
    p_supplier_name: supplierName,
    p_currency: "EUR",
    p_rule_set_id: result.rule_set.id,
    p_rule_set_version: result.rule_set.version,
    p_calc_input: { lines },
    p_calc_output: {
      subtotal_minor: result.subtotal_minor,
      tax_total_minor: result.tax_total_minor,
      withholding_minor: result.withholding_minor,
      total_minor: result.total_minor,
    },
    p_calc_trace: result.trace,
    p_lines: result.lines.map((l) => ({
      product_id: l.product_id,
      request_id: l.request_id,
      description: l.description,
      category_name: l.category_name,
      quantity: (l.quantity_milli / 1000).toString(),
      unit: l.unit,
      unit_price_minor: l.unit_price_minor,
      line_subtotal_minor: l.line_subtotal_minor,
      tax_minor: l.tax_minor,
      line_total_minor: l.line_total_minor,
      tax_detail: l.tax_detail,
    })),
    p_subtotal_minor: result.subtotal_minor,
    p_tax_total_minor: result.tax_total_minor,
    p_withholding_minor: result.withholding_minor,
    p_total_minor: result.total_minor,
  });

  if (error) {
    return { error: `Could not create the order: ${error.message}` };
  }

  revalidatePath("/dashboard/orders");
  redirect(`/dashboard/orders/${poId}`);
}

export async function requestOtp(
  poId: string,
  phone: string,
  channel: "sms" | "whatsapp",
): Promise<{ challengeId?: string; provider?: string; error?: string }> {
  const { status, json } = await invokeEdge("otp-request", {
    poId,
    phone,
    channel,
  });
  if (status === 200 && json?.challengeId) {
    return {
      challengeId: json.challengeId as string,
      provider: json.provider as string,
    };
  }
  if (status === 429) {
    const retry = json?.retry_after_seconds
      ? ` Retry in ${json.retry_after_seconds}s.`
      : "";
    return { error: `Rate limited (${json?.reason ?? "cooldown"}).${retry}` };
  }
  return {
    error:
      (json?.message as string) ??
      (json?.error as string) ??
      `Request failed (${status})`,
  };
}

export async function verifyOtpAndApprove(
  poId: string,
  challengeId: string,
  code: string,
): Promise<ActionResult & { ok?: boolean }> {
  const verify = await invokeEdge("otp-verify", { challengeId, code });
  if (verify.status !== 200) {
    const remaining = verify.json?.attemptsRemaining;
    const suffix =
      typeof remaining === "number" ? ` (${remaining} attempts left)` : "";
    return {
      error: `${(verify.json?.error as string) ?? "Verification failed"}${suffix}`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_purchase_order", {
    p_po_id: poId,
    p_challenge_id: challengeId,
  });
  if (error) return { error: `Approval failed: ${error.message}` };

  revalidatePath(`/dashboard/orders/${poId}`);
  revalidatePath("/dashboard/orders");
  return { ok: true };
}

export async function cancelOrder(poId: string): Promise<ActionResult | void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_purchase_order", {
    p_po_id: poId,
  });
  if (error) return { error: `Cancel failed: ${error.message}` };
  revalidatePath(`/dashboard/orders/${poId}`);
  revalidatePath("/dashboard/orders");
}

export async function pushOrderToXero(
  poId: string,
): Promise<ActionResult & { xeroInvoiceId?: string }> {
  const { status, json } = await invokeEdge("xero-sync", {
    action: "push_invoice",
    poId,
  });
  if (status === 200) {
    revalidatePath(`/dashboard/orders/${poId}`);
    return { xeroInvoiceId: (json?.xeroInvoiceId as string) ?? undefined };
  }
  return {
    error:
      (json?.message as string) ??
      (json?.error as string) ??
      `Push failed (${status})`,
  };
}
