/** Pure Stripe Checkout configuration helpers (no SDK/runtime dependency). */

export interface CheckoutReturnUrls {
  successUrl: string;
  cancelUrl: string;
}

/**
 * Accept exactly one configured application origin. Return URLs are never
 * accepted from the request, so a caller cannot turn Checkout into an open
 * redirect or send a customer to an attacker-controlled origin.
 */
export function checkoutReturnUrls(rawBaseUrl: string): CheckoutReturnUrls {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("APP_BASE_URL must be an absolute URL");
  }

  const localHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("APP_BASE_URL must use HTTPS (except localhost)");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("APP_BASE_URL must contain only an origin");
  }

  const origin = url.origin;
  return {
    successUrl: `${origin}/dashboard/billing?checkout=success`,
    cancelUrl: `${origin}/dashboard/billing?checkout=cancelled`,
  };
}

/** Stable across a retry after Stripe succeeded but the DB write failed. */
export function stripeCustomerIdempotencyKey(restaurantId: string): string {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
      .test(restaurantId)
  ) {
    throw new Error("restaurantId must be a UUID");
  }
  return `restamenu:billing-customer:${restaurantId}`;
}
