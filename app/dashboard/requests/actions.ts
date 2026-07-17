"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const PRIORITIES = ["urgent", "normal", "whenever", "by_breakfast", "by_lunch", "by_dinner"] as const;

export async function createRequest(formData: FormData) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("restaurant_members")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .single();
  if (!membership) redirect("/login");

  const productId = formData.get("product_id");
  const quantity = Number(formData.get("quantity"));
  const priority = String(formData.get("priority"));

  if (typeof productId !== "string" || !productId) {
    throw new Error("createRequest: product_id missing");
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`createRequest: invalid quantity ${formData.get("quantity")}`);
  }
  if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
    throw new Error(`createRequest: invalid priority ${priority}`);
  }

  // restaurant_id comes from the caller's own membership, never the form, so a
  // forged product_id still cannot place a row in another tenant — and RLS
  // rejects it a second time at the database.
  const { error } = await supabase.from("purchase_requests").insert({
    restaurant_id: membership.restaurant_id,
    product_id: productId,
    quantity,
    priority,
    created_by: user.id,
  });

  if (error) {
    throw new Error(`createRequest: insert failed (${error.code}): ${error.message}`);
  }

  revalidatePath("/dashboard/requests");
}
