/**
 * Supabase clients for Edge Functions.
 *
 * serviceClient(): service_role — bypasses RLS. Only for writes that have no
 * user in the loop (webhook processing, token storage, OTP internals). The
 * key never leaves the function runtime.
 *
 * userClient(req): anon key + the caller's own Authorization header — RLS
 * applies exactly as it does in the app, so tenant checks stay in Postgres.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name}_not_configured`);
  return value;
}

export function serviceClient(): SupabaseClient {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

export function userClient(req: Request): SupabaseClient {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: req.headers.get("Authorization") ?? "" },
      },
    },
  );
}

export interface CallerContext {
  userId: string;
  restaurantId: string;
  role: string;
}

/**
 * Resolve the calling user and their membership through their own JWT.
 * Returns null when the request is unauthenticated or the user has no
 * membership — callers turn that into a 401/403.
 */
export async function resolveCaller(
  req: Request,
): Promise<CallerContext | null> {
  const supabase = userClient(req);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError) {
    // Invalid/expired credentials are an authentication outcome. Auth server
    // failures are operational errors and must reach the function's 500 path.
    if (typeof authError.status === "number" && authError.status < 500) {
      return null;
    }
    throw authError;
  }
  if (!user) return null;

  const requestedRestaurantId = req.headers.get("x-restamenu-restaurant-id");
  let membershipQuery = supabase
    .from("restaurant_members")
    .select("restaurant_id, role")
    .eq("user_id", user.id);
  if (requestedRestaurantId) {
    membershipQuery = membershipQuery.eq(
      "restaurant_id",
      requestedRestaurantId,
    );
  }
  const { data: memberships, error: membershipError } = await membershipQuery
    .order("joined_at", { ascending: true })
    .limit(2);
  if (membershipError) throw membershipError;
  if (!memberships || memberships.length === 0) return null;
  if (!requestedRestaurantId && memberships.length > 1) {
    throw new Error("active_restaurant_required");
  }
  const membership = memberships[0];

  return {
    userId: user.id,
    restaurantId: membership.restaurant_id,
    role: membership.role,
  };
}
