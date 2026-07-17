import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import NavBar from "@/components/NavBar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("restaurant_members")
    .select("role, restaurants(id, name, region)")
    .eq("user_id", user.id)
    .single();

  // Supabase join returns array or object depending on relation type; cast safely
  const restaurantRaw = membership?.restaurants;
  const restaurant = (
    Array.isArray(restaurantRaw) ? restaurantRaw[0] : restaurantRaw
  ) as { id: string; name: string; region: string } | null | undefined;

  return (
    <>
      <NavBar
        restaurantName={restaurant?.name ?? "—"}
        restaurantRegion={restaurant?.region ?? "—"}
        role={membership?.role ?? "staff"}
        userEmail={user.email ?? ""}
      />
      {children}
    </>
  );
}
