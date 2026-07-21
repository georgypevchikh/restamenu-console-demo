export interface RestaurantChoice {
  id: string;
  name: string;
  region: string;
  role: string;
}

export function chooseActiveRestaurant(
  memberships: RestaurantChoice[],
  requestedId: string | undefined,
): RestaurantChoice | null {
  if (memberships.length === 0) return null;
  return (
    memberships.find((membership) => membership.id === requestedId) ??
    memberships[0]
  );
}
