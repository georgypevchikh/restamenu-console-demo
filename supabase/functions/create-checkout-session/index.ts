/**
 * POST {} → { url }
 *
 * Creates a Stripe test-mode Checkout session for the caller's restaurant.
 * Manager-only. The restaurant id travels in both session and subscription
 * metadata so the webhook can route events back to the tenant without
 * guessing. The Stripe customer is created lazily on first checkout and
 * remembered in billing_customers.
 */

import Stripe from "npm:stripe@18";
import { resolveCaller, serviceClient } from "../_shared/db.ts";
import { errorJson, internalError, json } from "../_shared/http.ts";
import {
  checkoutReturnUrls,
  stripeCustomerIdempotencyKey,
} from "../_shared/core/stripe-checkout.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const priceId = Deno.env.get("STRIPE_PRICE_ID");
    const appBaseUrl = Deno.env.get("APP_BASE_URL");
    if (!secretKey || !priceId || !appBaseUrl) {
      return json(503, {
        error: "not_configured",
        missing: [
          ...(secretKey ? [] : ["STRIPE_SECRET_KEY"]),
          ...(priceId ? [] : ["STRIPE_PRICE_ID"]),
          ...(appBaseUrl ? [] : ["APP_BASE_URL"]),
        ],
      });
    }

    const caller = await resolveCaller(req);
    if (!caller) return errorJson(401, "not_authenticated");
    if (caller.role !== "manager") return errorJson(403, "manager_required");

    let successUrl: string;
    let cancelUrl: string;
    try {
      ({ successUrl, cancelUrl } = checkoutReturnUrls(appBaseUrl));
    } catch (error) {
      console.error("[create-checkout-session] invalid APP_BASE_URL", error);
      return json(503, {
        error: "not_configured",
        missing: ["APP_BASE_URL (valid HTTPS origin)"],
      });
    }

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });
    const db = serviceClient();

    const { data: existing, error: existingError } = await db
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("restaurant_id", caller.restaurantId)
      .maybeSingle();
    if (existingError) {
      return internalError("create-checkout-session", existingError);
    }

    let customerId = existing?.stripe_customer_id as string | undefined;
    if (!customerId) {
      // All concurrent/retried first-checkout requests for one tenant use the
      // same Stripe key. This prevents duplicate customers when Stripe accepts
      // the POST but our following database write is interrupted.
      const customer = await stripe.customers.create(
        { metadata: { restaurant_id: caller.restaurantId } },
        { idempotencyKey: stripeCustomerIdempotencyKey(caller.restaurantId) },
      );
      customerId = customer.id;
      const { error } = await db.from("billing_customers").upsert(
        {
          restaurant_id: caller.restaurantId,
          stripe_customer_id: customerId,
        },
        { onConflict: "restaurant_id" },
      );
      if (error) return internalError("create-checkout-session", error);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { restaurant_id: caller.restaurantId },
      subscription_data: { metadata: { restaurant_id: caller.restaurantId } },
    });

    if (!session.url) {
      return internalError(
        "create-checkout-session",
        new Error("Stripe returned a Checkout Session without a hosted URL"),
      );
    }

    return json(200, { url: session.url });
  } catch (err) {
    return internalError("create-checkout-session", err);
  }
});
