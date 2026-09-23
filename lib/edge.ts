import { getRestaurantContext } from "@/lib/current-restaurant";
import { SUPABASE_PUBLIC_KEY } from "@/lib/supabase/key";

/** Edge Function names are internal identifiers: lowercase, digits, dashes. */
const EDGE_FUNCTION_NAME = /^[a-z0-9-]+$/;

/**
 * Build the absolute URL for a Supabase Edge Function.
 *
 * The name is validated against a strict allowlist pattern so it can never
 * carry a scheme, host, or path traversal, and the URL is assembled with the
 * WHATWG `URL` constructor — the host is fixed by `base`, and a rooted path
 * can never override it. This makes the request target provably constant.
 */
export function edgeFunctionUrl(name: string): string {
  if (!EDGE_FUNCTION_NAME.test(name)) {
    throw new Error(`invalid edge function name: ${name}`);
  }
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  }
  return new URL(`/functions/v1/${name}`, base).toString();
}

/**
 * Server-side bridge to Supabase Edge Functions. The caller's own access
 * token rides along, so functions resolve the user through RLS exactly as
 * the app does — the web tier still holds no privileged key.
 */
export async function invokeEdge(
  name: string,
  body: unknown,
): Promise<{
  status: number;
  json: Record<string, unknown> | null;
  raw: Response;
}> {
  const context = await getRestaurantContext();
  if (!context) {
    return {
      status: 401,
      json: { error: "not_authenticated" },
      raw: new Response(null, { status: 401 }),
    };
  }
  const {
    data: { session },
    error: sessionError,
  } = await context.supabase.auth.getSession();
  if (sessionError || !session) {
    return {
      status: sessionError ? 500 : 401,
      json: {
        error: sessionError ? "session_unavailable" : "not_authenticated",
      },
      raw: new Response(null, { status: sessionError ? 500 : 401 }),
    };
  }

  const res = await fetch(
    edgeFunctionUrl(name),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLIC_KEY,
        "X-Restamenu-Restaurant-Id": context.active.id,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );

  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { status: res.status, json, raw: res };
}
