import NavBar from "@/components/NavBar";
import { requireRestaurantContext } from "@/lib/current-restaurant";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { active, memberships, user } = await requireRestaurantContext();

  return (
    <>
      <NavBar
        restaurantName={active.name}
        restaurantRegion={active.region}
        role={active.role}
        userEmail={user.email ?? ""}
        restaurantId={active.id}
        restaurants={memberships}
      />
      {children}
    </>
  );
}
