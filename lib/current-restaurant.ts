import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertQuerySucceeded } from "@/lib/supabase/query";
import {
  chooseActiveRestaurant,
  type RestaurantChoice,
} from "@/lib/restaurant-selection";

export const ACTIVE_RESTAURANT_COOKIE = "restamenu_active_restaurant";

function relatedRestaurant(value: unknown): {
  id: string;
  name: string;
  region: string;
} | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const candidate = row as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.region !== "string"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    region: candidate.region,
  };
}

export async function getRestaurantContext() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return null;

  const { data, error } = await supabase
    .from("restaurant_members")
    .select("restaurant_id, role, joined_at, restaurants(id, name, region)")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .order("restaurant_id", { ascending: true });
  assertQuerySucceeded(error, "load your restaurant memberships");

  const memberships: RestaurantChoice[] = (data ?? []).map((membership) => {
    const restaurant = relatedRestaurant(membership.restaurants);
    if (!restaurant || restaurant.id !== membership.restaurant_id) {
      throw new Error(
        "Restaurant membership points to an unavailable restaurant.",
      );
    }
    return { ...restaurant, role: membership.role };
  });
  if (memberships.length === 0) return null;

  const cookieStore = await cookies();
  const requestedId = cookieStore.get(ACTIVE_RESTAURANT_COOKIE)?.value;
  const active = chooseActiveRestaurant(memberships, requestedId);
  if (!active) return null;

  return { supabase, user, active, memberships };
}

export async function requireRestaurantContext() {
  const context = await getRestaurantContext();
  if (!context) {
    // An authenticated account can legitimately exist before an invitation is
    // accepted, or after its final membership is removed. Sending that account
    // to /login creates a redirect loop because middleware correctly considers
    // it signed in. Distinguish the two states explicitly on this cold path.
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    redirect(user ? "/no-membership" : "/login");
  }
  return context;
}
