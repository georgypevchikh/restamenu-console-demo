/**
 * Stripe webhook receiver. verify_jwt=false — the request is authenticated by
 * its signature, verified with constructEventAsync (the sync variant needs
 * Node crypto, which Deno does not have).
 *
 * Pipeline per delivery:
 *   1. verify signature → 400 on mismatch
 *   2. reduceStripeEvent() (pure, unit-tested) decides what the event means
 *   3. apply_stripe_event() claims the event and applies its customer or
 *      subscription side effect in ONE Postgres transaction
 *   4. only after the side effect and entitlement trigger succeed does the
 *      transaction mark the ledger row processed. Failures roll back the
 *      claim, so Stripe retries; concurrent duplicates serialize on event id.
 *
 * Entitlements, audit rows and outbox events are NOT written here — the
 * subscription_entitlement_sync trigger (migration 016) does that in the same
 * transaction as the subscription write.
 *
 * Always 200 for handled/skipped events so Stripe stops retrying; non-2xx
 * only for signature failures and genuine internal errors.
 */

import Stripe from "npm:stripe@18";
import { serviceClient } from "../_shared/db.ts";
import { errorJson, internalError, json } from "../_shared/http.ts";
import type { StripeEventLike } from "../_shared/core/stripe-reducer.ts";
import {
  hydrateMutableSubscriptionEvent,
  processVerifiedStripeEvent,
  type StripeApplyResult,
} from "../_shared/core/stripe-processor.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!secretKey || !webhookSecret) {
      return json(503, {
        error: "not_configured",
        missing: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      });
    }

    const signature = req.headers.get("stripe-signature");
    if (!signature) return errorJson(400, "missing_signature");

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });
    const rawBody = await req.text();

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        webhookSecret,
        undefined,
        cryptoProvider,
      );
    } catch (err) {
      console.error("[stripe-webhook] signature verification failed:", err);
      return errorJson(400, "invalid_signature");
    }

    const canonicalEvent = await hydrateMutableSubscriptionEvent(
      event as unknown as StripeEventLike,
      async (subscriptionId) =>
        await stripe.subscriptions.retrieve(
          subscriptionId,
        ) as unknown as StripeEventLike["data"]["object"],
    );

    const db = serviceClient();
    const outcome = await processVerifiedStripeEvent(
      canonicalEvent,
      async (params) => {
        // One RPC = one Postgres transaction. A failed side effect rolls the
        // event claim back; a concurrent duplicate serializes on the event id.
        const { data, error } = await db.rpc("apply_stripe_event", params);
        if (error) throw error;
        return data as StripeApplyResult;
      },
    );

    return json(outcome.status, outcome.body);
  } catch (err) {
    return internalError("stripe-webhook", err);
  }
});
