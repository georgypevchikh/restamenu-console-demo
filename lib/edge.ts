import { getRestaurantContext } from "@/lib/current-restaurant";

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
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${name}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
