/**
 * Runtime-agnostic orchestration for a verified Stripe event.
 *
 * Signature verification stays in the Edge Function. Persistence is injected
 * as one atomic operation (`apply_stripe_event` in Postgres), so this module is
 * testable without Stripe, Supabase, or a network connection.
 */

import { reduceStripeEvent, type StripeEventLike } from "./stripe-reducer.ts";

export interface StripeApplyParams {
  p_event_id: string;
  p_event_type: string;
  p_decision_kind: "skip" | "link_customer" | "upsert_subscription";
  p_reason: string | null;
  p_restaurant_id: string | null;
  p_customer_id: string | null;
  p_subscription_id: string | null;
  p_subscription_status: string | null;
  p_price_id: string | null;
  p_current_period_end: string | null;
  p_cancel_at_period_end: boolean;
  p_event_created: number;
}

export type StripeApplyResult =
  | { result: "duplicate" }
  | { result: "skipped"; reason?: string }
  | { result: "linked" }
  | { result: "stale" }
  | { result: "applied"; status: string };

export interface StripeProcessorResponse {
  status: number;
  body: Record<string, unknown>;
}

export type ApplyStripeEvent = (
  params: StripeApplyParams,
) => Promise<StripeApplyResult>;

export type RetrieveStripeSubscription = (
  subscriptionId: string,
) => Promise<StripeEventLike["data"]["object"]>;

/**
 * Stripe doesn't promise webhook ordering. For mutable subscription events,
 * retrieve the canonical current object before reducing it. A delayed
 * `updated` delivery therefore cannot resurrect state from its old snapshot.
 * Deleted events are already terminal snapshots and are deliberately not
 * retrieved.
 */
export async function hydrateMutableSubscriptionEvent(
  event: StripeEventLike,
  retrieve: RetrieveStripeSubscription,
): Promise<StripeEventLike> {
  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated"
  ) {
    return event;
  }

  const subscriptionId = event.data.object.id;
  if (!subscriptionId) return event;

  const current = await retrieve(subscriptionId);
  return {
    ...event,
    data: { object: current },
  };
}

export function buildStripeApplyParams(
  event: StripeEventLike,
): StripeApplyParams {
  const decision = reduceStripeEvent(event);
  const base = {
    p_event_id: event.id,
    p_event_type: event.type,
    p_reason: null,
    p_restaurant_id: null,
    p_customer_id: null,
    p_subscription_id: null,
    p_subscription_status: null,
    p_price_id: null,
    p_current_period_end: null,
    p_cancel_at_period_end: false,
    p_event_created: event.created,
  };

  if (decision.kind === "skip") {
    return {
      ...base,
      p_decision_kind: "skip",
      p_reason: decision.reason,
    };
  }

  if (decision.kind === "link_customer") {
    return {
      ...base,
      p_decision_kind: "link_customer",
      p_restaurant_id: decision.restaurantId,
      p_customer_id: decision.customerId,
    };
  }

  return {
    ...base,
    p_decision_kind: "upsert_subscription",
    p_restaurant_id: decision.restaurantId,
    p_customer_id: decision.customerId,
    p_subscription_id: decision.stripeSubscriptionId,
    p_subscription_status: decision.status,
    p_price_id: decision.priceId,
    p_current_period_end: decision.currentPeriodEnd,
    p_cancel_at_period_end: decision.cancelAtPeriodEnd,
    p_event_created: decision.eventCreated,
  };
}

/**
 * Apply one already-signature-verified event through the atomic persistence
 * boundary and translate its result into the webhook response contract.
 * Persistence errors intentionally propagate: Stripe must receive a 5xx and
 * retry; swallowing one here would recreate the poisoned-ledger bug.
 */
export async function processVerifiedStripeEvent(
  event: StripeEventLike,
  apply: ApplyStripeEvent,
): Promise<StripeProcessorResponse> {
  const params = buildStripeApplyParams(event);
  const outcome = await apply(params);

  switch (outcome.result) {
    case "duplicate":
      return { status: 200, body: { received: true, duplicate: true } };
    case "skipped":
      return {
        status: 200,
        body: {
          received: true,
          skipped: outcome.reason ?? params.p_reason ?? "unhandled event",
        },
      };
    case "linked":
      return { status: 200, body: { received: true, linked: true } };
    case "stale":
      return { status: 200, body: { received: true, stale: true } };
    case "applied":
      return {
        status: 200,
        body: { received: true, applied: outcome.status },
      };
    default: {
      const exhaustive: never = outcome;
      throw new Error(
        `unknown Stripe apply result: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
