/** Atomic Stripe webhook orchestration — no SDK, database, or network. */

import { describe, it, expect } from "vitest";
import {
  buildStripeApplyParams,
  hydrateMutableSubscriptionEvent,
  processVerifiedStripeEvent,
  type ApplyStripeEvent,
  type StripeApplyParams,
} from "../supabase/functions/_shared/core/stripe-processor.ts";
import type { StripeEventLike } from "../supabase/functions/_shared/core/stripe-reducer.ts";

const RESTAURANT = "11111111-0000-0000-0000-000000000001";

function subscriptionEvent(id = "evt_subscription_1"): StripeEventLike {
  return {
    id,
    type: "customer.subscription.updated",
    created: 1_800_000_000,
    data: {
      object: {
        id: "sub_123",
        status: "active",
        customer: "cus_123",
        metadata: { restaurant_id: RESTAURANT },
        items: { data: [{ price: { id: "price_123" } }] },
        current_period_end: 1_802_592_000,
      },
    },
  };
}

function checkoutEvent(): StripeEventLike {
  return {
    id: "evt_checkout_1",
    type: "checkout.session.completed",
    created: 1_800_000_001,
    data: {
      object: {
        customer: "cus_123",
        metadata: { restaurant_id: RESTAURANT },
      },
    },
  };
}

describe("buildStripeApplyParams", () => {
  it("maps a subscription event to the single atomic RPC payload", () => {
    expect(buildStripeApplyParams(subscriptionEvent())).toEqual({
      p_event_id: "evt_subscription_1",
      p_event_type: "customer.subscription.updated",
      p_decision_kind: "upsert_subscription",
      p_reason: null,
      p_restaurant_id: RESTAURANT,
      p_customer_id: "cus_123",
      p_subscription_id: "sub_123",
      p_subscription_status: "active",
      p_price_id: "price_123",
      p_current_period_end: new Date(1_802_592_000 * 1000).toISOString(),
      p_cancel_at_period_end: false,
      p_event_created: 1_800_000_000,
    });
  });

  it("maps skipped and customer-link decisions without inventing fields", () => {
    const skipped = buildStripeApplyParams({
      id: "evt_unknown",
      type: "invoice.finalized",
      created: 10,
      data: { object: {} },
    });
    expect(skipped.p_decision_kind).toBe("skip");
    expect(skipped.p_reason).toContain("unhandled event type");

    const linked = buildStripeApplyParams(checkoutEvent());
    expect(linked).toMatchObject({
      p_decision_kind: "link_customer",
      p_restaurant_id: RESTAURANT,
      p_customer_id: "cus_123",
      p_subscription_id: null,
    });
  });
});

describe("hydrateMutableSubscriptionEvent", () => {
  it("replaces a delayed mutable snapshot with Stripe's canonical current subscription", async () => {
    const delayed = subscriptionEvent("evt_delayed");
    delayed.data.object.status = "active";

    const hydrated = await hydrateMutableSubscriptionEvent(delayed, async (id) => ({
      id,
      status: "canceled",
      customer: "cus_123",
      metadata: { restaurant_id: RESTAURANT },
      items: { data: [{ price: { id: "price_123" } }] },
    }));

    expect(hydrated.data.object.status).toBe("canceled");
    expect(hydrated.created).toBe(delayed.created);
  });

  it("does not retrieve terminal deletes, checkout events, or malformed events", async () => {
    let calls = 0;
    const retrieve = async () => {
      calls += 1;
      return {};
    };

    const deleted = subscriptionEvent("evt_deleted");
    deleted.type = "customer.subscription.deleted";
    await hydrateMutableSubscriptionEvent(deleted, retrieve);
    await hydrateMutableSubscriptionEvent(checkoutEvent(), retrieve);
    const malformed = subscriptionEvent("evt_malformed");
    delete malformed.data.object.id;
    await hydrateMutableSubscriptionEvent(malformed, retrieve);

    expect(calls).toBe(0);
  });

  it("propagates retrieval failures so Stripe retries the delivery", async () => {
    await expect(
      hydrateMutableSubscriptionEvent(subscriptionEvent(), async () => {
        throw new Error("Stripe temporarily unavailable");
      }),
    ).rejects.toThrow("Stripe temporarily unavailable");
  });
});

describe("processVerifiedStripeEvent", () => {
  it("calls exactly one persistence boundary and returns its applied status", async () => {
    const calls: StripeApplyParams[] = [];
    const result = await processVerifiedStripeEvent(subscriptionEvent(), async (params) => {
      calls.push(params);
      return { result: "applied", status: "active" };
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      status: 200,
      body: { received: true, applied: "active" },
    });
  });

  it("acknowledges committed duplicates without running another domain side effect", async () => {
    let sideEffects = 0;
    let committed = false;
    let inFlight: Promise<void> | null = null;
    let release: (() => void) | null = null;

    // In-memory stand-in for the migration's unique-id transaction boundary:
    // the second call waits for the first commit, then observes a duplicate.
    const apply: ApplyStripeEvent = async () => {
      if (committed) return { result: "duplicate" };
      if (inFlight) {
        await inFlight;
        return { result: "duplicate" };
      }

      inFlight = new Promise<void>((resolve) => {
        release = resolve;
      });
      await Promise.resolve();
      sideEffects += 1;
      committed = true;
      release?.();
      return { result: "applied", status: "active" };
    };

    const [a, b] = await Promise.all([
      processVerifiedStripeEvent(subscriptionEvent(), apply),
      processVerifiedStripeEvent(subscriptionEvent(), apply),
    ]);

    expect(sideEffects).toBe(1);
    expect([a.body, b.body]).toContainEqual({ received: true, applied: "active" });
    expect([a.body, b.body]).toContainEqual({ received: true, duplicate: true });
  });

  it("propagates a transient persistence failure so Stripe can retry", async () => {
    let attempts = 0;
    const apply: ApplyStripeEvent = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database unavailable");
      return { result: "linked" };
    };

    await expect(processVerifiedStripeEvent(checkoutEvent(), apply)).rejects.toThrow(
      "database unavailable"
    );
    await expect(processVerifiedStripeEvent(checkoutEvent(), apply)).resolves.toEqual({
      status: 200,
      body: { received: true, linked: true },
    });
    expect(attempts).toBe(2);
  });

  it("reports stale and deliberately skipped events as successful acknowledgements", async () => {
    await expect(
      processVerifiedStripeEvent(subscriptionEvent(), async () => ({ result: "stale" }))
    ).resolves.toEqual({ status: 200, body: { received: true, stale: true } });

    await expect(
      processVerifiedStripeEvent(
        {
          id: "evt_unknown",
          type: "invoice.finalized",
          created: 10,
          data: { object: {} },
        },
        async (params) => ({ result: "skipped", reason: params.p_reason ?? undefined })
      )
    ).resolves.toEqual({
      status: 200,
      body: { received: true, skipped: "unhandled event type: invoice.finalized" },
    });
  });
});
