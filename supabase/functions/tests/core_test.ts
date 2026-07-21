/**
 * Deno-side tests of the shared core. The full behavioural matrix lives in
 * the Vitest suites (tests/*.test.ts); this file proves runtime parity — the
 * same modules produce the same numbers and hashes under Deno, where the
 * Edge Functions actually run.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  applyRateBps,
  lineSubtotalMinor,
  MoneyError,
  parseQuantityToMilli,
} from "../_shared/core/money.ts";
import {
  calculate,
  type RuleSet,
  selectRuleSet,
  TaxEngineError,
} from "../_shared/core/tax-engine.ts";
import {
  generateOtpCode,
  generateSalt,
  hashOtpCode,
  verifyOtpCode,
} from "../_shared/core/otp-core.ts";
import { reduceStripeEvent } from "../_shared/core/stripe-reducer.ts";
import {
  checkoutReturnUrls,
  stripeCustomerIdempotencyKey,
} from "../_shared/core/stripe-checkout.ts";
import {
  buildBillPayload,
  buildExternalContactNumber,
  buildXeroReference,
  classifyRefreshFailure,
  normalizeSupplierKey,
  parseContactIdsByName,
  parseCreatedInvoiceId,
  parseInvoiceIdsByReference,
  resolveRefreshFailure,
  sanitizeInternalPath,
  withOne401Retry,
} from "../_shared/core/xero-core.ts";

const RULE_SET: RuleSet = {
  id: "rs-v1",
  version: 1,
  name: "EU VAT 2026 H1",
  effective_from: "2026-01-01",
  effective_to: "2026-06-30",
  rounding_mode: "half_up",
  rules: [
    {
      kind: "vat",
      name: "Standard VAT",
      rate_bps: 2100,
      applies_to: "default",
    },
    {
      kind: "vat",
      name: "Reduced VAT",
      rate_bps: 900,
      applies_to: "categories",
      categories: ["Produce"],
    },
    {
      kind: "withholding",
      name: "Vendor withholding",
      rate_bps: 200,
      threshold_minor: 100_000,
    },
  ],
};

Deno.test("money: rounding parity with the Node suite", () => {
  assertEquals(applyRateBps(50, 2100, "half_up"), 11);
  assertEquals(applyRateBps(50, 2100, "bankers"), 10);
  assertEquals(lineSubtotalMinor(2500, 399, "half_up"), 998);
  assertEquals(parseQuantityToMilli("12.345"), 12345);
  assertThrows(() => parseQuantityToMilli("-1"), MoneyError);
});

Deno.test("Stripe checkout: configured-origin and idempotency parity", () => {
  assertEquals(checkoutReturnUrls("https://console.example.com"), {
    successUrl:
      "https://console.example.com/dashboard/billing?checkout=success",
    cancelUrl:
      "https://console.example.com/dashboard/billing?checkout=cancelled",
  });
  assertEquals(
    stripeCustomerIdempotencyKey(
      "11111111-0000-4000-8000-000000000001",
    ),
    "restamenu:billing-customer:11111111-0000-4000-8000-000000000001",
  );
  assertThrows(
    () => checkoutReturnUrls("https://console.example.com/redirect"),
    Error,
  );
});

Deno.test("tax engine: mixed-category order parity", () => {
  const result = calculate(RULE_SET, [
    {
      description: "Flour 00",
      category_name: "Dry goods",
      quantity: "20",
      unit_price_minor: 120,
    },
    {
      description: "Tomatoes",
      category_name: "Produce",
      quantity: "5",
      unit_price_minor: 250,
    },
  ]);
  assertEquals(result.subtotal_minor, 3650);
  assertEquals(result.tax_total_minor, 617);
  assertEquals(result.total_minor, 4267);
  assertEquals(result.lines[1].tax_detail.rule_name, "Reduced VAT");
});

Deno.test("tax engine: version selection by effective date", () => {
  const v2: RuleSet = {
    ...RULE_SET,
    id: "rs-v2",
    version: 2,
    effective_from: "2026-07-01",
    effective_to: null,
  };
  assertEquals(selectRuleSet([RULE_SET, v2], "2026-03-01").version, 1);
  assertEquals(selectRuleSet([RULE_SET, v2], "2026-08-01").version, 2);
  assertThrows(
    () => selectRuleSet([RULE_SET, v2], "2026-02-31"),
    TaxEngineError,
  );
});

Deno.test("tax engine: unsafe arithmetic is rejected under Deno", () => {
  assertThrows(
    () =>
      calculate(RULE_SET, [{
        description: "Unsafe",
        quantity: "999999999999.999",
        unit_price_minor: 999999999999,
      }]),
    TaxEngineError,
  );
});

Deno.test("otp: hash round trip under Deno WebCrypto", async () => {
  const code = generateOtpCode();
  const salt = generateSalt();
  const hash = await hashOtpCode(code, salt);
  assertEquals(await verifyOtpCode(code, salt, hash), true);
  assertEquals(
    await verifyOtpCode("000000" === code ? "000001" : "000000", salt, hash),
    false,
  );
});

Deno.test("stripe reducer: deleted subscription lands as canceled", () => {
  const decision = reduceStripeEvent({
    id: "evt_1",
    type: "customer.subscription.deleted",
    created: 1_800_000_000,
    data: {
      object: {
        id: "sub_1",
        status: "active",
        customer: "cus_1",
        metadata: { restaurant_id: "r-1" },
      },
    },
  });
  assertEquals(decision.kind, "upsert_subscription");
  if (decision.kind === "upsert_subscription") {
    assertEquals(decision.status, "canceled");
  }
});

Deno.test("xero: callback paths cannot escape the app origin", () => {
  assertEquals(
    sanitizeInternalPath("/dashboard/settings/xero"),
    "/dashboard/settings/xero",
  );
  assertEquals(
    sanitizeInternalPath("//attacker.example"),
    "/dashboard/settings/xero",
  );
  assertEquals(
    sanitizeInternalPath("/\\attacker.example"),
    "/dashboard/settings/xero",
  );
});

Deno.test("xero: created invoice requires a valid InvoiceID", () => {
  const id = "8f5c2d65-53d4-4a1b-9f69-e829f5e77e44";
  assertEquals(parseCreatedInvoiceId({ Invoices: [{ InvoiceID: id }] }), id);
  assertThrows(() => parseCreatedInvoiceId({ Invoices: [{}] }));
});

Deno.test("xero: ContactID payload and reconciliation identities", async () => {
  const restaurantId = "11111111-0000-4000-8000-000000000001";
  const contactId = "97c2dc5e-e907-4b4e-8210-54d82b0aa479";
  const invoiceId = "8f5c2d65-53d4-4a1b-9f69-e829f5e77e44";
  const reference = buildXeroReference(restaurantId, "PO-2026-0001");
  assertEquals(
    await buildExternalContactNumber(restaurantId, "fresh farms ltd"),
    "RM:8c2b419da5d5572d9ee74905",
  );
  assertEquals(normalizeSupplierKey(" Fresh   FARMS Ltd "), "fresh farms ltd");
  assertEquals(
    parseContactIdsByName(
      { Contacts: [{ Name: "fresh farms ltd", ContactID: contactId }] },
      "Fresh Farms Ltd",
    ),
    [contactId],
  );
  assertEquals(
    parseInvoiceIdsByReference(
      {
        Invoices: [{
          Type: "ACCPAY",
          Reference: reference,
          InvoiceID: invoiceId,
        }],
      },
      reference,
    ),
    [invoiceId],
  );
  const payload = buildBillPayload(
    {
      po_number: "PO-2026-0001",
      supplier_name: "Fresh Farms Ltd",
      currency: "EUR",
      created_at: "2026-07-21T10:00:00Z",
      subtotal_minor: 250,
      tax_total_minor: 53,
      withholding_minor: 0,
      total_minor: 303,
      lines: [{
        description: "Tomatoes",
        quantity_milli: 1000,
        unit_price_minor: 250,
        line_subtotal_minor: 250,
      }],
    },
    contactId,
    reference,
  ) as { Invoices: Array<{ Contact: { ContactID: string } }> };
  assertEquals(payload.Invoices[0].Contact.ContactID, contactId);
});

Deno.test("xero: 401 refresh is attempted exactly once", async () => {
  let requests = 0;
  let refreshes = 0;
  const result = await withOne401Retry({
    token: "old",
    request: (_token) => {
      requests += 1;
      return Promise.resolve({ status: 401 });
    },
    refresh: (_token) => {
      refreshes += 1;
      return Promise.resolve("new");
    },
    status: (response) => response.status,
  });
  assertEquals(result.response.status, 401);
  assertEquals(requests, 2);
  assertEquals(refreshes, 1);
});

Deno.test("xero: stale refresh loser reads the concurrent winner", async () => {
  const winner = { refresh: "winner", status: "connected" };
  assertEquals(
    await resolveRefreshFailure({
      markExpiredIfCurrent: () => Promise.resolve(false),
      readCurrent: () => Promise.resolve(winner),
    }),
    { kind: "superseded", current: winner },
  );
});

Deno.test("xero: transient refresh outage is not an expired connection", () => {
  assertEquals(classifyRefreshFailure("refresh_transient_failure"), {
    terminal: false,
    status: 503,
    code: "xero_refresh_temporarily_unavailable",
  });
  assertEquals(classifyRefreshFailure("refresh_grant_expired"), {
    terminal: true,
    status: 409,
    code: "xero_connection_expired",
  });
});
