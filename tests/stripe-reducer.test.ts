/** Stripe event reducer — pure decision logic, no Stripe SDK involved. */

import { describe, it, expect } from "vitest";
import {
  reduceStripeEvent,
  isStale,
  type StripeEventLike,
} from "../supabase/functions/_shared/core/stripe-reducer.ts";

const RESTAURANT = "11111111-0000-0000-0000-000000000001";

function subscriptionEvent(
  type: string,
  overrides: Partial<StripeEventLike["data"]["object"]> = {},
  created = 1_800_000_000
): StripeEventLike {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type,
    created,
    data: {
      object: {
        id: "sub_123",
        object: "subscription",
        status: "active",
        customer: "cus_123",
        cancel_at_period_end: false,
        metadata: { restaurant_id: RESTAURANT },
        items: { data: [{ price: { id: "price_123" } }] },
        current_period_end: 1_802_592_000,
        ...overrides,
      },
    },
  };
}

describe("reduceStripeEvent", () => {
  it("maps subscription.created to an upsert with tenant routing", () => {
    const d = reduceStripeEvent(subscriptionEvent("customer.subscription.created"));
    expect(d.kind).toBe("upsert_subscription");
    if (d.kind !== "upsert_subscription") return;
    expect(d.stripeSubscriptionId).toBe("sub_123");
    expect(d.restaurantId).toBe(RESTAURANT);
    expect(d.status).toBe("active");
    expect(d.priceId).toBe("price_123");
    expect(d.currentPeriodEnd).toBe(new Date(1_802_592_000 * 1000).toISOString());
  });

  it("subscription.deleted always lands as canceled", () => {
    const d = reduceStripeEvent(
      subscriptionEvent("customer.subscription.deleted", { status: "active" })
    );
    expect(d.kind).toBe("upsert_subscription");
    if (d.kind !== "upsert_subscription") return;
    expect(d.status).toBe("canceled");
  });

  it("past_due flows through unchanged (entitlement trigger revokes)", () => {
    const d = reduceStripeEvent(
      subscriptionEvent("customer.subscription.updated", { status: "past_due" })
    );
    if (d.kind !== "upsert_subscription") throw new Error("expected upsert");
    expect(d.status).toBe("past_due");
  });

  it("falls back to customer routing when metadata is absent", () => {
    const d = reduceStripeEvent(
      subscriptionEvent("customer.subscription.updated", { metadata: null })
    );
    if (d.kind !== "upsert_subscription") throw new Error("expected upsert");
    expect(d.restaurantId).toBeNull();
    expect(d.customerId).toBe("cus_123");
  });

  it("checkout.session.completed links customer to tenant", () => {
    const d = reduceStripeEvent({
      id: "evt_cs",
      type: "checkout.session.completed",
      created: 1_800_000_000,
      data: {
        object: {
          id: "cs_123",
          object: "checkout.session",
          customer: "cus_123",
          metadata: { restaurant_id: RESTAURANT },
        },
      },
    });
    expect(d).toEqual({ kind: "link_customer", customerId: "cus_123", restaurantId: RESTAURANT });
  });

  it("skips unknown event types and malformed payloads", () => {
    expect(
      reduceStripeEvent({ id: "e", type: "invoice.finalized", created: 1, data: { object: {} } }).kind
    ).toBe("skip");
    expect(
      reduceStripeEvent(subscriptionEvent("customer.subscription.updated", { status: "mystery" })).kind
    ).toBe("skip");
    expect(
      reduceStripeEvent({
        id: "e",
        type: "checkout.session.completed",
        created: 1,
        data: { object: { customer: "cus_1", metadata: {} } },
      }).kind
    ).toBe("skip");
  });

  it("expands object-shaped customer references", () => {
    const d = reduceStripeEvent(
      subscriptionEvent("customer.subscription.updated", { customer: { id: "cus_obj" }, metadata: null })
    );
    if (d.kind !== "upsert_subscription") throw new Error("expected upsert");
    expect(d.customerId).toBe("cus_obj");
  });
});

describe("isStale", () => {
  it("older events are stale, equal and newer are not", () => {
    expect(isStale(100, 200)).toBe(true);
    expect(isStale(200, 200)).toBe(false); // same-second events pass; the id ledger catches duplicates
    expect(isStale(300, 200)).toBe(false);
  });
});
