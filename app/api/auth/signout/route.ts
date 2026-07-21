import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_RESTAURANT_COOKIE } from "@/lib/current-restaurant";

export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(ACTIVE_RESTAURANT_COOKIE);
  redirect("/login");
}
