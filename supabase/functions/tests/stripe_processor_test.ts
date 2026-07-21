import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  hydrateMutableSubscriptionEvent,
  processVerifiedStripeEvent,
} from "../_shared/core/stripe-processor.ts";
import type { StripeEventLike } from "../_shared/core/stripe-reducer.ts";

const event: StripeEventLike = {
  id: "evt_deno_processor",
  type: "customer.subscription.updated",
  created: 1_800_000_000,
  data: {
    object: {
      id: "sub_deno",
      status: "active",
      customer: "cus_deno",
      metadata: { restaurant_id: "11111111-0000-0000-0000-000000000001" },
    },
  },
};

Deno.test("Stripe processor preserves the atomic RPC contract under Deno", async () => {
  let calls = 0;
  const response = await processVerifiedStripeEvent(event, async (params) => {
    calls += 1;
    assertEquals(params.p_event_id, "evt_deno_processor");
    assertEquals(params.p_decision_kind, "upsert_subscription");
    return { result: "applied", status: "active" };
  });

  assertEquals(calls, 1);
  assertEquals(response, {
    status: 200,
    body: { received: true, applied: "active" },
  });
});

Deno.test("Stripe processor hydrates delayed mutable events under Deno", async () => {
  const hydrated = await hydrateMutableSubscriptionEvent(event, async (id) => ({
    id,
    status: "past_due",
    customer: "cus_deno",
    metadata: { restaurant_id: "11111111-0000-0000-0000-000000000001" },
  }));
  assertEquals(hydrated.data.object.status, "past_due");
});

Deno.test("Stripe processor does not swallow a retryable persistence error", async () => {
  await assertRejects(
    () =>
      processVerifiedStripeEvent(event, async () => {
        throw new Error("transient database error");
      }),
    Error,
    "transient database error",
  );
});
