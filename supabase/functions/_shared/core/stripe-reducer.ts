/**
 * Pure reducer for Stripe webhook events: event in, decision out. The
 * stripe-webhook Edge Function verifies the signature, records the event in
 * the idempotency ledger, then asks this reducer what the event means. All
 * branching lives here so it can be unit-tested without Stripe, a network,
 * or a database.
 *
 * Ordering: Stripe does not guarantee delivery order. Each subscription row
 * remembers the `created` timestamp of the last applied event
 * (last_event_created); an event older than that is stale and skipped.
 * Equal timestamps pass — exact duplicates are already caught by the event-id
 * ledger before the reducer runs.
 */

export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The subset of a Stripe event the reducer needs. */
export interface StripeEventLike {
  id: string;
  type: string;
  created: number; // unix seconds
  data: {
    object: {
      id?: string;
      object?: string;
      status?: string;
      customer?: string | { id: string };
      subscription?: string | { id: string } | null;
      cancel_at_period_end?: boolean;
      metadata?: Record<string, string> | null;
      items?: { data?: Array<{ price?: { id?: string } }> };
      current_period_end?: number | null;
    };
  };
}

export type ReducerDecision =
  | {
    kind: "upsert_subscription";
    stripeSubscriptionId: string;
    restaurantId: string | null; // null → resolve via billing_customers by customerId
    customerId: string | null;
    status: SubscriptionStatus;
    priceId: string | null;
    currentPeriodEnd: string | null; // ISO
    cancelAtPeriodEnd: boolean;
    eventCreated: number;
  }
  | {
    kind: "link_customer";
    customerId: string;
    restaurantId: string;
  }
  | { kind: "skip"; reason: string };

function customerId(
  c: string | { id: string } | undefined | null,
): string | null {
  if (!c) return null;
  return typeof c === "string" ? c : c.id;
}

export function reduceStripeEvent(event: StripeEventLike): ReducerDecision {
  const obj = event.data.object;

  if (event.type === "checkout.session.completed") {
    const cust = customerId(obj.customer);
    const restaurantId = obj.metadata?.restaurant_id ?? null;
    if (!cust || !restaurantId) {
      return {
        kind: "skip",
        reason: "checkout session without customer or restaurant_id metadata",
      };
    }
    return { kind: "link_customer", customerId: cust, restaurantId };
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    if (!obj.id) {
      return { kind: "skip", reason: "subscription event without id" };
    }

    // A deleted subscription reports its last live status; the mirror should
    // say canceled regardless.
    const rawStatus = event.type === "customer.subscription.deleted"
      ? "canceled"
      : obj.status;
    if (
      !rawStatus ||
      !(SUBSCRIPTION_STATUSES as readonly string[]).includes(rawStatus)
    ) {
      return {
        kind: "skip",
        reason: `unknown subscription status: ${rawStatus}`,
      };
    }

    return {
      kind: "upsert_subscription",
      stripeSubscriptionId: obj.id,
      restaurantId: obj.metadata?.restaurant_id ?? null,
      customerId: customerId(obj.customer),
      status: rawStatus as SubscriptionStatus,
      priceId: obj.items?.data?.[0]?.price?.id ?? null,
      currentPeriodEnd: obj.current_period_end
        ? new Date(obj.current_period_end * 1000).toISOString()
        : null,
      cancelAtPeriodEnd: obj.cancel_at_period_end ?? false,
      eventCreated: event.created,
    };
  }

  return { kind: "skip", reason: `unhandled event type: ${event.type}` };
}

/** Stale-event guard: apply only if this event is not older than the last applied one. */
export function isStale(
  eventCreated: number,
  lastEventCreated: number,
): boolean {
  return eventCreated < lastEventCreated;
}
