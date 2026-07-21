/**
 * Tenant isolation + privilege tests for the billing extension tables
 * (migrations 015–022), in the same spirit as tenant-isolation.test.ts:
 * signed-in demo users against the live database, asserting that Postgres —
 * not the app — enforces the boundaries.
 *
 * Seeded state this relies on (migrations 017/021): Bella Italia has an
 * active billing_pro entitlement and both restaurants have two tax rule set
 * versions.
 */

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, it, expect } from "vitest";
import * as dotenv from "dotenv";
import * as path from "path";
import WebSocket from "ws";

if (!globalThis.WebSocket) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = WebSocket;
}

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const TEST_DEMO_PASSWORD = process.env.TEST_DEMO_PASSWORD ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_DEMO_PASSWORD) {
  throw new Error(
    "Live billing tests require NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY, and TEST_DEMO_PASSWORD",
  );
}

const BELLA = {
  manager: "manager@bella-italia.demo",
  staff: "staff@bella-italia.demo",
  restaurantId: "11111111-0000-0000-0000-000000000001",
};
const SAKURA = {
  manager: "manager@sakura-house.demo",
  restaurantId: "22222222-0000-0000-0000-000000000002",
};

async function signedInClient(email: string) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: TEST_DEMO_PASSWORD,
  });
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`);
  return client;
}

type SignedInClient = Awaited<ReturnType<typeof signedInClient>>;
let bellaClient: SignedInClient;
let sakuraClient: SignedInClient;
let staffClient: SignedInClient;
let bellaUserId: string;
let staffUserId: string;

describe("Billing extension — tenant isolation", () => {
  beforeAll(async () => {
    [bellaClient, sakuraClient, staffClient] = await Promise.all([
      signedInClient(BELLA.manager),
      signedInClient(SAKURA.manager),
      signedInClient(BELLA.staff),
    ]);
    const [{ data: bellaAuth }, { data: staffAuth }] = await Promise.all([
      bellaClient.auth.getSession(),
      staffClient.auth.getSession(),
    ]);
    if (!bellaAuth.session || !staffAuth.session) {
      throw new Error("Demo session missing after sign-in");
    }
    bellaUserId = bellaAuth.session.user.id;
    staffUserId = staffAuth.session.user.id;
  });

  it("Bella manager sees its entitlement; Sakura manager sees none", async () => {
    const bella = bellaClient;
    const sakura = sakuraClient;

    const [bellaEnt, sakuraEnt] = await Promise.all([
      bella.from("entitlements").select("feature, active"),
      sakura.from("entitlements").select("feature, active"),
    ]);

    expect(bellaEnt.error).toBeNull();
    expect(bellaEnt.data).toEqual([{ feature: "billing_pro", active: true }]);
    // Sakura has no subscription — and must not see Bella's row
    expect(sakuraEnt.error).toBeNull();
    expect(sakuraEnt.data).toHaveLength(0);

  });

  it("subscriptions are invisible across tenants", async () => {
    const sakura = sakuraClient;
    const { data, error } = await sakura.from("subscriptions").select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("Team sees only its own requests while the manager sees the full queue", async () => {
    const [teamResult, managerResult] = await Promise.all([
      staffClient
        .from("purchase_requests")
        .select("id, created_by")
        .eq("restaurant_id", BELLA.restaurantId),
      bellaClient
        .from("purchase_requests")
        .select("id, created_by")
        .eq("restaurant_id", BELLA.restaurantId),
    ]);

    expect(teamResult.error).toBeNull();
    expect(managerResult.error).toBeNull();
    expect(teamResult.data!.length).toBeGreaterThan(0);
    expect(teamResult.data!.every((row) => row.created_by === staffUserId)).toBe(true);
    expect(managerResult.data!.length).toBeGreaterThan(teamResult.data!.length);
    expect(managerResult.data!.some((row) => row.created_by === bellaUserId)).toBe(true);
  });

  it("Team cannot read manager-only financial and delivery surfaces", async () => {
    const managerOnlyTables = [
      "purchases",
      "audit_events",
      "outbox_events",
      "billing_customers",
      "subscriptions",
      "entitlements",
      "tax_rule_sets",
      "tax_calculations",
      "purchase_orders",
      "purchase_order_lines",
      "xero_sync_log",
      "xero_bills",
    ];

    for (const table of managerOnlyTables) {
      const { data, error } = await staffClient.from(table).select("*").limit(1);
      expect(error, `${table} should be filtered by RLS`).toBeNull();
      expect(data, `${table} must be invisible to Team`).toHaveLength(0);
    }

    const { error: statusError } = await staffClient.rpc("xero_connection_status", {
      p_restaurant_id: BELLA.restaurantId,
    });
    expect(statusError).not.toBeNull();
    expect(statusError!.message).toContain("manager_required");
  });

  it("tax rule sets are tenant-scoped and versioned", async () => {
    const bella = bellaClient;
    const { data, error } = await bella
      .from("tax_rule_sets")
      .select("restaurant_id, version")
      .order("version");
    expect(error).toBeNull();
    expect(data!.map((r) => r.version)).toEqual([1, 2]);
    expect(data!.every((r) => r.restaurant_id === BELLA.restaurantId)).toBe(true);
  });

  it("rejects ambiguous tax-rule JSON at the database boundary", async () => {
    const { data, error } = await bellaClient
      .from("tax_rule_sets")
      .insert({
        restaurant_id: BELLA.restaurantId,
        version: 2_000_000_026,
        name: "Invalid duplicate category test",
        effective_from: "2099-01-01",
        effective_to: null,
        rounding_mode: "half_up",
        created_by: bellaUserId,
        rules: [
          {
            kind: "vat",
            name: "Reduced A",
            rate_bps: 500,
            applies_to: "categories",
            categories: ["Produce"],
          },
          {
            kind: "vat",
            name: "Reduced B",
            rate_bps: 900,
            applies_to: "categories",
            categories: ["Produce"],
          },
        ],
      })
      .select();

    expect(error).not.toBeNull();
    expect(error!.code).toBe("P0001");
    expect(error!.message).toContain(
      "invalid_tax_rule_set:duplicate_category:Produce",
    );
    expect(data).toBeNull();
  });

  it("rejects oversized PO inputs before financial calculation", async () => {
    const { error } = await bellaClient.rpc("create_purchase_order", {
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: "S".repeat(201),
      p_currency: "EUR",
      p_rule_set_id: null,
      p_rule_set_version: 1,
      p_calc_input: { lines: [{ description: "Item" }] },
      p_calc_output: {},
      p_calc_trace: [],
      p_lines: [{}],
      p_subtotal_minor: 0,
      p_tax_total_minor: 0,
      p_withholding_minor: 0,
      p_total_minor: 0,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe("P0001");
    expect(error!.message).toContain("invalid_supplier_name");
  });

  it("audit events do not leak across tenants", async () => {
    const sakura = sakuraClient;
    // The seeded subscription audit row belongs to Bella
    const { data, error } = await sakura.from("audit_events").select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("outbox events are readable by their tenant only", async () => {
    const bella = bellaClient;
    const sakura = sakuraClient;
    const [bellaEvents, sakuraEvents] = await Promise.all([
      bella.from("outbox_events").select("event_type"),
      sakura.from("outbox_events").select("event_type"),
    ]);
    expect(bellaEvents.data!.length).toBeGreaterThan(0);
    expect(sakuraEvents.data).toHaveLength(0);
  });

  it("system tables are invisible to every user role", async () => {
    const bella = bellaClient;
    for (const table of ["stripe_events", "otp_challenges", "xero_connections", "xero_oauth_states", "po_counters"]) {
      const { data, error } = await bella.from(table).select("*").limit(1);
      // Deny-all RLS: not an error, just zero rows.
      expect(error, `${table} should be silently empty`).toBeNull();
      expect(data, `${table} must return no rows`).toHaveLength(0);
    }
  });

  it("does not expose the internal entitlement oracle to authenticated users", async () => {
    const bella = bellaClient;
    const { error } = await bella.rpc("has_entitlement", {
      p_restaurant_id: BELLA.restaurantId,
      p_feature: "billing_pro",
    });
    expect(error).not.toBeNull();
    expect(error!.message.toLowerCase()).toContain("permission denied");
  });

  it("direct INSERT into purchase_orders is rejected even for managers", async () => {
    const bella = bellaClient;
    const { error } = await bella.from("purchase_orders").insert({
      restaurant_id: BELLA.restaurantId,
      po_number: "PO-HACK-0001",
      supplier_name: "Direct Insert Ltd",
    });
    // No INSERT policy exists — documents only come from create_purchase_order()
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("create_purchase_order requires the entitlement (Sakura is blocked)", async () => {
    const sakura = sakuraClient;
    const { error } = await sakura.rpc("create_purchase_order", {
      p_restaurant_id: SAKURA.restaurantId,
      p_supplier_name: "Test Vendor",
      p_currency: "EUR",
      p_rule_set_id: null,
      p_rule_set_version: 1,
      p_calc_input: {},
      p_calc_output: {},
      p_calc_trace: {},
      p_lines: [
        {
          description: "X",
          quantity: "1",
          unit_price_minor: 100,
          line_subtotal_minor: 100,
          tax_minor: 21,
          line_total_minor: 121,
        },
      ],
      p_subtotal_minor: 100,
      p_tax_total_minor: 21,
      p_withholding_minor: 0,
      p_total_minor: 121,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("entitlement_required");
  });

  it("staff cannot create purchase orders (manager_required)", async () => {
    const staff = staffClient;
    const { error } = await staff.rpc("create_purchase_order", {
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: "Test Vendor",
      p_currency: "EUR",
      p_rule_set_id: null,
      p_rule_set_version: 1,
      p_calc_input: {},
      p_calc_output: {},
      p_calc_trace: {},
      p_lines: [
        {
          description: "X",
          quantity: "1",
          unit_price_minor: 100,
          line_subtotal_minor: 100,
          tax_minor: 21,
          line_total_minor: 121,
        },
      ],
      p_subtotal_minor: 100,
      p_tax_total_minor: 21,
      p_withholding_minor: 0,
      p_total_minor: 121,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("manager_required");
  });

  it("recomputes tax in Postgres and rejects client-tampered totals", async () => {
    const bella = bellaClient;
    const { data: ruleSet } = await bella
      .from("tax_rule_sets")
      .select("id, version")
      .eq("version", 2)
      .single();

    // H2's default rate is 22%, but the payload claims 21%. Before migration
    // 024 the RPC only checked that the client-provided lines added up to the
    // client-provided total, so this forged calculation was accepted.
    const inputLine = {
      product_id: null,
      request_id: null,
      description: "Manual item",
      category_name: null,
      quantity: "1",
      unit: "unit",
      unit_price_minor: 100,
    };
    const claimedLine = {
      ...inputLine,
      line_subtotal_minor: 100,
      tax_minor: 21,
      line_total_minor: 121,
      tax_detail: { rule_name: "forged", rate_bps: 2100 },
    };

    const { error } = await bella.rpc("create_purchase_order", {
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: "Tampered Calculation Ltd",
      p_currency: "EUR",
      p_rule_set_id: ruleSet!.id,
      p_rule_set_version: ruleSet!.version,
      p_calc_input: { lines: [inputLine] },
      p_calc_output: {
        subtotal_minor: 100,
        tax_total_minor: 21,
        withholding_minor: 0,
        total_minor: 121,
      },
      p_calc_trace: [{ step: "client_claim" }],
      p_lines: [claimedLine],
      p_subtotal_minor: 100,
      p_tax_total_minor: 21,
      p_withholding_minor: 0,
      p_total_minor: 121,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("totals_mismatch");
  });

  it("rejects a purchase-order source row owned by another tenant", async () => {
    const bella = bellaClient;
    const sakura = sakuraClient;

    const [{ data: ruleSet }, { data: foreignRequest }] = await Promise.all([
      bella.from("tax_rule_sets").select("id, version").eq("version", 2).single(),
      sakura
        .from("purchase_requests")
        .select("id, product_id, quantity, products(name, unit)")
        .eq("status", "pending")
        .limit(1)
        .single(),
    ]);

    const product = Array.isArray(foreignRequest!.products)
      ? foreignRequest!.products[0]
      : foreignRequest!.products;
    const inputLine = {
      request_id: foreignRequest!.id,
      product_id: foreignRequest!.product_id,
      description: product?.name ?? "Foreign item",
      category_name: null,
      quantity: String(foreignRequest!.quantity),
      unit: product?.unit ?? "unit",
      unit_price_minor: 100,
    };

    const { error } = await bella.rpc("create_purchase_order", {
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: "Cross Tenant Ltd",
      p_currency: "EUR",
      p_rule_set_id: ruleSet!.id,
      p_rule_set_version: ruleSet!.version,
      p_calc_input: { lines: [inputLine] },
      p_calc_output: {
        subtotal_minor: 100,
        tax_total_minor: 22,
        withholding_minor: 0,
        total_minor: 122,
      },
      p_calc_trace: [],
      p_lines: [{ ...inputLine, line_subtotal_minor: 100, tax_minor: 22, line_total_minor: 122 }],
      p_subtotal_minor: 100,
      p_tax_total_minor: 22,
      p_withholding_minor: 0,
      p_total_minor: 122,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("request_not_owned_by_tenant");
  });

  it("atomically claims a request, rejects concurrent reuse, and releases it on cancel", async () => {
    const [{ data: request, error: requestError }, { data: ruleSet, error: ruleError }] =
      await Promise.all([
        bellaClient
          .from("purchase_requests")
          .select("id, product_id, quantity, products(name, unit, categories(name))")
          .eq("restaurant_id", BELLA.restaurantId)
          .eq("status", "pending")
          .is("claimed_by_po_id", null)
          .limit(1)
          .single(),
        bellaClient
          .from("tax_rule_sets")
          .select("id, version")
          .eq("version", 2)
          .single(),
      ]);

    expect(requestError).toBeNull();
    expect(ruleError).toBeNull();

    const productRelation = request!.products;
    const product = (Array.isArray(productRelation)
      ? productRelation[0]
      : productRelation) as {
      name: string;
      unit: string | null;
      categories: { name: string } | { name: string }[] | null;
    };
    const categoryRelation = product.categories;
    const categoryName = Array.isArray(categoryRelation)
      ? categoryRelation[0]?.name ?? null
      : categoryRelation?.name ?? null;
    const quantity = String(request!.quantity);
    const subtotalMinor = Number(quantity) * 100;
    expect(Number.isSafeInteger(subtotalMinor)).toBe(true);
    const vatRateBps = categoryName === "Produce" || categoryName === "Dairy" ? 900 : 2200;
    const taxMinor = Math.floor((subtotalMinor * vatRateBps + 5_000) / 10_000);
    const totalMinor = subtotalMinor + taxMinor;
    const inputLine = {
      request_id: request!.id,
      product_id: request!.product_id,
      description: product.name,
      category_name: categoryName,
      quantity,
      unit: product.unit,
      unit_price_minor: 100,
    };
    const persistedLine = {
      ...inputLine,
      line_subtotal_minor: subtotalMinor,
      tax_minor: taxMinor,
      line_total_minor: totalMinor,
      tax_detail: { rule_name: "test assertion", rate_bps: vatRateBps },
    };
    const orderArgs = (supplier: string) => ({
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: supplier,
      p_currency: "EUR",
      p_rule_set_id: ruleSet!.id,
      p_rule_set_version: ruleSet!.version,
      p_calc_input: { lines: [inputLine] },
      p_calc_output: {
        subtotal_minor: subtotalMinor,
        tax_total_minor: taxMinor,
        withholding_minor: 0,
        total_minor: totalMinor,
      },
      p_calc_trace: [],
      p_lines: [persistedLine],
      p_subtotal_minor: subtotalMinor,
      p_tax_total_minor: taxMinor,
      p_withholding_minor: 0,
      p_total_minor: totalMinor,
    });

    const createdPoIds: string[] = [];
    try {
      // Both transactions target the same source row. The request-row lock and
      // claim compare-and-set must let exactly one document commit.
      const attempts = await Promise.all([
        bellaClient.rpc("create_purchase_order", orderArgs("Concurrent claimant A")),
        bellaClient.rpc("create_purchase_order", orderArgs("Concurrent claimant B")),
      ]);
      for (const attempt of attempts) {
        if (!attempt.error && typeof attempt.data === "string") {
          createdPoIds.push(attempt.data);
        }
      }

      expect(createdPoIds).toHaveLength(1);
      const losingAttempt = attempts.find((attempt) => attempt.error);
      expect(losingAttempt?.error).not.toBeNull();
      expect(
        ["request_not_pending", "purchase_request_claim_conflict"].some((code) =>
          losingAttempt!.error!.message.includes(code),
        ),
      ).toBe(true);

      const { data: claimed, error: claimError } = await bellaClient
        .from("purchase_requests")
        .select("status, claimed_by_po_id")
        .eq("id", request!.id)
        .single();
      expect(claimError).toBeNull();
      expect(claimed).toEqual({ status: "bought", claimed_by_po_id: createdPoIds[0] });

      const { error: reuseError } = await bellaClient.rpc(
        "create_purchase_order",
        orderArgs("Sequential reuse attempt"),
      );
      expect(reuseError).not.toBeNull();
      expect(reuseError!.message).toContain("request_not_pending");
    } finally {
      for (const poId of createdPoIds) {
        const { error: cancelError } = await bellaClient.rpc("cancel_purchase_order", {
          p_po_id: poId,
        });
        expect(cancelError).toBeNull();
      }

      if (createdPoIds.length > 0) {
        const { data: released, error: releaseError } = await bellaClient
          .from("purchase_requests")
          .select("status, claimed_by_po_id")
          .eq("id", request!.id)
          .single();
        expect(releaseError).toBeNull();
        expect(released).toEqual({ status: "pending", claimed_by_po_id: null });
      }
    }
  });

  it("rejects negative unit prices before persistence", async () => {
    const bella = bellaClient;
    const { data: ruleSet } = await bella
      .from("tax_rule_sets")
      .select("id, version")
      .eq("version", 2)
      .single();
    const inputLine = {
      product_id: null,
      request_id: null,
      description: "Negative item",
      category_name: null,
      quantity: "1",
      unit: "unit",
      unit_price_minor: -1,
    };

    const { error } = await bella.rpc("create_purchase_order", {
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: "Negative Ltd",
      p_currency: "EUR",
      p_rule_set_id: ruleSet!.id,
      p_rule_set_version: ruleSet!.version,
      p_calc_input: { lines: [inputLine] },
      p_calc_output: {
        subtotal_minor: -1,
        tax_total_minor: 0,
        withholding_minor: 0,
        total_minor: -1,
      },
      p_calc_trace: [],
      p_lines: [{ ...inputLine, line_subtotal_minor: -1, tax_minor: 0, line_total_minor: -1 }],
      p_subtotal_minor: -1,
      p_tax_total_minor: 0,
      p_withholding_minor: 0,
      p_total_minor: -1,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("unit_price_must_be_nonnegative_integer");
  });

  it("approve_purchase_order without a verified OTP challenge is rejected", async () => {
    const bella = bellaClient;

    // A real draft created through the front door, then an approval attempt
    // with a bogus challenge id.
    const { data: ruleSet } = await bella
      .from("tax_rule_sets")
      .select("id, version")
      .eq("version", 2)
      .single();

    const { data: poId, error: createError } = await bella.rpc("create_purchase_order", {
      p_restaurant_id: BELLA.restaurantId,
      p_supplier_name: "Isolation Test Vendor",
      p_currency: "EUR",
      p_rule_set_id: ruleSet!.id,
      p_rule_set_version: ruleSet!.version,
      p_calc_input: {
        lines: [
          {
            product_id: null,
            request_id: null,
            description: "Test item",
            category_name: null,
            quantity: "1",
            unit: "unit",
            unit_price_minor: 100,
          },
        ],
      },
      p_calc_output: {
        subtotal_minor: 100,
        tax_total_minor: 22,
        withholding_minor: 0,
        total_minor: 122,
      },
      p_calc_trace: [{ step: "test" }],
      p_lines: [
        {
          description: "Test item",
          quantity: "1",
          unit_price_minor: 100,
          line_subtotal_minor: 100,
          tax_minor: 22,
          line_total_minor: 122,
        },
      ],
      p_subtotal_minor: 100,
      p_tax_total_minor: 22,
      p_withholding_minor: 0,
      p_total_minor: 122,
    });
    expect(createError).toBeNull();
    expect(poId).toBeTruthy();

    const { error: approveError } = await bella.rpc("approve_purchase_order", {
      p_po_id: poId,
      p_challenge_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(approveError).not.toBeNull();
    expect(approveError!.message).toContain("otp_verification_required");

    // Cleanup: cancel the draft so reruns do not accumulate open documents.
    const { error: cancelError } = await bella.rpc("cancel_purchase_order", { p_po_id: poId });
    expect(cancelError).toBeNull();

  });

  it("purchase orders are invisible across tenants", async () => {
    const sakura = sakuraClient;
    const { data, error } = await sakura
      .from("purchase_orders")
      .select("id")
      .eq("restaurant_id", BELLA.restaurantId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
