"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createRequest(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: membership } = await supabase
    .from("restaurant_members")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .single();
  if (!membership) return;

  await supabase.from("purchase_requests").insert({
    restaurant_id: membership.restaurant_id,
    product_id: formData.get("product_id") as string,
    quantity: Number(formData.get("quantity")),
    priority: formData.get("priority") as string,
    created_by: user.id,
  });

  revalidatePath("/dashboard/requests");
}
