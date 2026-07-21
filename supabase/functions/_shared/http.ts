/** Response helpers for Edge Functions. Callers are server-side (Next.js
 * server actions / Stripe / Xero redirects), so no CORS headers are needed. */

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function errorJson(
  status: number,
  code: string,
  message?: string,
): Response {
  return json(status, { error: code, message: message ?? code });
}

/** Uniform catch-all: log the real error, return an opaque 500. */
export function internalError(fn: string, err: unknown): Response {
  console.error(`[${fn}]`, err);
  return errorJson(500, "internal_error");
}
