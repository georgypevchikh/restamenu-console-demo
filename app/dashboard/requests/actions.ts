"use server";

import { revalidatePath } from "next/cache";
import { parsePurchaseRequestInput } from "@/lib/request-input";
import { requireRestaurantContext } from "@/lib/current-restaurant";

export async function createRequest(formData: FormData) {
  const { supabase, active, user } = await requireRestaurantContext();

  let request: ReturnType<typeof parsePurchaseRequestInput>;
  try {
    request = parsePurchaseRequestInput({
      productId: formData.get("product_id"),
      quantity: formData.get("quantity"),
      priority: formData.get("priority"),
    });
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Request data is invalid.",
    };
  }

  // restaurant_id comes from the caller's own membership, never the form, so a
  // forged product_id still cannot place a row in another tenant — and RLS
  // rejects it a second time at the database.
  const { error } = await supabase.from("purchase_requests").insert({
    restaurant_id: active.id,
    product_id: request.productId,
    quantity: request.quantity,
    priority: request.priority,
    created_by: user.id,
  });

  if (error) {
    console.error("createRequest insert failed", {
      code: error.code,
      message: error.message,
      details: error.details,
    });
    return { error: "The request could not be saved. Please try again." };
  }

  revalidatePath("/dashboard/requests");
  return { ok: true as const };
}
