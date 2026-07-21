/**
 * Webhook signature verification under Deno — the exact code path
 * stripe-webhook/index.ts runs: constructEventAsync + SubtleCryptoProvider.
 *
 * Test headers are signed manually with WebCrypto using Stripe's documented
 * scheme (`t=<ts>,v1=hex(HMAC-SHA256(secret, "<ts>.<payload>"))`) because the
 * SDK's generateTestHeaderString helper needs a synchronous HMAC, which the
 * Deno build's SubtleCryptoProvider cannot do. A passing suite means a real
 * Stripe delivery signed with the same secret would verify.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import Stripe from "npm:stripe@18";

const SECRET = "whsec_test_secret_for_signature_tests";
const stripe = new Stripe("sk_test_dummy_key_never_used_for_api_calls", {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const payload = JSON.stringify({
  id: "evt_test_1",
  object: "event",
  type: "customer.subscription.updated",
  created: 1_800_000_000,
  data: { object: { id: "sub_test", object: "subscription", status: "active" } },
});

async function signPayload(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000)
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  );
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

Deno.test("a correctly signed payload verifies", async () => {
  const header = await signPayload(payload, SECRET);
  const event = await stripe.webhooks.constructEventAsync(
    payload,
    header,
    SECRET,
    undefined,
    cryptoProvider
  );
  assertEquals(event.id, "evt_test_1");
  assertEquals(event.type, "customer.subscription.updated");
});

Deno.test("a tampered payload is rejected", async () => {
  const header = await signPayload(payload, SECRET);
  const tampered = payload.replace('"active"', '"canceled"');
  await assertRejects(() =>
    stripe.webhooks.constructEventAsync(tampered, header, SECRET, undefined, cryptoProvider)
  );
});

Deno.test("a signature from the wrong secret is rejected", async () => {
  const header = await signPayload(payload, "whsec_some_other_secret");
  await assertRejects(() =>
    stripe.webhooks.constructEventAsync(payload, header, SECRET, undefined, cryptoProvider)
  );
});

Deno.test("an expired timestamp is rejected (replay window)", async () => {
  const header = await signPayload(payload, SECRET, Math.floor(Date.now() / 1000) - 600);
  await assertRejects(() =>
    stripe.webhooks.constructEventAsync(payload, header, SECRET, undefined, cryptoProvider)
  );
});
