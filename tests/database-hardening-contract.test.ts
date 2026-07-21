import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/026_database_trust_boundaries.sql",
  ),
  "utf8",
);

describe("database trust-boundary migration contract", () => {
  it("binds each purchase request to a product in the same restaurant", () => {
    expect(migration).toMatch(
      /foreign key \(product_id, restaurant_id\)[\s\S]*references public\.products \(id, restaurant_id\)/,
    );
    expect(migration).toContain("quantity > 0");
    expect(migration).toContain(
      "quantity * 1000 = trunc(quantity * 1000)",
    );
    expect(migration).toContain(
      "quantity * 1000 <= 9007199254740991::numeric",
    );
    expect(migration).toContain(
      "validate constraint purchase_requests_product_restaurant_fkey",
    );
    expect(migration).toContain(
      "validate constraint purchase_requests_quantity_valid",
    );
  });

  it("binds legacy category and purchase-history relationships to a tenant", () => {
    expect(migration).toMatch(
      /foreign key \(category_id, restaurant_id\)[\s\S]*references public\.categories \(id, restaurant_id\)/,
    );
    expect(migration).toContain("on delete set null (category_id)");
    expect(migration).toMatch(
      /foreign key \(request_id, restaurant_id\)[\s\S]*references public\.purchase_requests \(id, restaurant_id\)/,
    );
    expect(migration).toContain("on delete set null (request_id)");
    expect(migration).toContain(
      "create unique index suppliers_one_primary_per_product_idx",
    );
    expect(migration).toContain("where is_primary");
  });

  it("requires authenticated requests to be the caller's own pending row", () => {
    expect(migration).toContain("created_by = (select auth.uid())");
    expect(migration).toContain("and status = 'pending'");
    expect(migration).toContain("and claimed_by_po_id is null");
    expect(migration).toContain("and quantity > 0");
    expect(migration).toContain("request_identity_is_immutable");
    expect(migration).toContain("invalid_request_status_transition");
    expect(migration).toContain(
      'drop policy if exists "requests: manager delete"',
    );
  });

  it("claims request sources atomically and releases only on PO cancellation", () => {
    expect(migration).toContain("add column claimed_by_po_id uuid");
    expect(migration).toContain("duplicate_active_purchase_request_lines");
    expect(migration).toContain("duplicate_request_in_purchase_order");
    expect(migration).toContain("purchase_request_claim_conflict");
    expect(migration).toMatch(
      /set claimed_by_po_id = v_po_id,[\s\S]*status = 'bought'/,
    );
    expect(migration).toContain(
      "rename to cancel_purchase_order_without_request_release",
    );
    expect(migration).toMatch(
      /perform public\.cancel_purchase_order_without_request_release\(p_po_id\)[\s\S]*set status = 'pending',[\s\S]*claimed_by_po_id = null/,
    );
    expect(migration).toContain(
      "grant update (status) on table public.purchase_requests to authenticated",
    );
  });

  it("requires an explicit, authorized restaurant for purchase-order creation", () => {
    expect(migration).toMatch(
      /create or replace function public\.create_purchase_order\(\s*p_restaurant_id\s+uuid/,
    );
    expect(migration).toMatch(
      /create function public\.create_purchase_order_validated_impl\(\s*p_restaurant_id\s+uuid/,
    );
    expect(migration).toMatch(
      /where rm\.restaurant_id = p_restaurant_id[\s\S]*rm\.user_id = v_uid[\s\S]*rm\.role = 'manager'/,
    );
    expect(migration).toContain(
      "public.create_purchase_order_validated_impl(\n    p_restaurant_id,",
    );
    expect(migration).toContain(
      "drop function public.create_purchase_order_validated_impl(",
    );
  });

  it("validates tax JSON deeply before it can become selectable", () => {
    expect(migration).toContain("create or replace function public.assert_valid_tax_rule_set");
    expect(migration).toContain("jsonb_array_length(p_rules) > 100");
    expect(migration).toContain("v_rate > 10000");
    expect(migration).toContain("v_threshold > 9007199254740991::numeric");
    expect(migration).toContain("invalid_tax_rule_set:duplicate_category");
    expect(migration).toContain("invalid_tax_rule_set:multiple_default_vat_rules");
    expect(migration).toContain("invalid_tax_rule_set:multiple_withholding_rules");
    expect(migration).toMatch(
      /for r in[\s\S]*from public\.tax_rule_sets[\s\S]*perform public\.assert_valid_tax_rule_set/,
    );
    expect(migration).toContain(
      "before insert or update on public.tax_rule_sets",
    );
  });

  it("bounds purchase-order text, line counts and JSON envelopes", () => {
    expect(migration).toContain(
      "length(btrim(supplier_name)) between 1 and 200",
    );
    expect(migration).toContain("currency ~ '^[A-Z]{3}$'");
    expect(migration).toContain(
      "length(btrim(description)) between 1 and 300",
    );
    expect(migration).toContain("length(unit) <= 50");
    expect(migration).toContain(
      "jsonb_array_length(p_calc_input->'lines') not between 1 and 250",
    );
    expect(migration).toContain("octet_length(p_calc_input::text) > 262144");
    expect(migration).toContain("octet_length(p_lines::text) > 524288");
    expect(migration).toContain(
      "public.create_purchase_order_validated_impl",
    );
  });

  it("does not consume outbox attempts without both URL and auth", () => {
    expect(migration).toMatch(
      /if nullif\(btrim\(v_url\), ''\) is null[\s\S]*or nullif\(btrim\(v_auth\), ''\) is null then[\s\S]*return 0/,
    );
    expect(migration).toContain("'Authorization', v_auth");
    expect(migration).not.toContain("coalesce(v_auth, '')");
  });

  it("routes urgent requests only through the authenticated durable outbox", () => {
    expect(migration).toContain(
      "drop function if exists public.notify_urgent_request()",
    );
    expect(migration).toContain(
      "create or replace function public.queue_urgent_request()",
    );
    expect(migration).toContain("'request.urgent'");
    expect(migration).toContain(
      "perform public.emit_outbox_event(",
    );
    const queueStart = migration.indexOf(
      "create or replace function public.queue_urgent_request()",
    );
    const queueEnd = migration.indexOf(
      "create trigger urgent_request_alert",
      queueStart,
    );
    expect(queueStart).toBeGreaterThan(-1);
    expect(queueEnd).toBeGreaterThan(queueStart);
    expect(migration.slice(queueStart, queueEnd)).not.toContain("net.http_post");
  });

  it("rate-limits OTP by authenticated user and restaurant before spoofable buckets", () => {
    const functionStart = migration.indexOf(
      "create or replace function public.issue_otp_challenge",
    );
    const functionEnd = migration.indexOf(
      "create or replace function public.queue_urgent_request",
      functionStart,
    );
    const fn = migration.slice(functionStart, functionEnd);
    expect(fn).toContain("'otp-restaurant:' || p_restaurant_id::text");
    expect(fn).toContain("'otp-user:' || p_user_id::text");
    expect(fn).toContain("v_user_hour >= 5");
    expect(fn).toContain("v_restaurant_hour >= 20");
    expect(fn.indexOf("v_user_hour >= 5")).toBeLessThan(
      fn.indexOf("v_phone_hour >= 5"),
    );
    expect(migration).toContain(
      "create index otp_challenges_user_created_idx",
    );
    expect(migration).toContain(
      "create index otp_challenges_restaurant_created_idx",
    );
  });

  it("removes duplicate permissive SELECT policies without broadening access", () => {
    expect(migration).toContain('drop policy if exists "profiles: own read"');
    expect(migration).toContain('drop policy if exists "profiles: teammate read"');
    expect(migration).toContain('create policy "profiles: own or teammate read"');
    expect(migration).toContain('drop policy if exists "suppliers: manager write"');
    expect(migration).toContain('create policy "suppliers: manager insert"');
    expect(migration).toContain('create policy "suppliers: manager update"');
    expect(migration).toContain('create policy "suppliers: manager delete"');
  });

  it("limits Team to its own requests and keeps financial surfaces manager-only", () => {
    expect(migration).toContain(
      'create policy "requests: manager all or team own read"',
    );
    expect(migration).toContain("created_by = (select auth.uid())");
    for (const policy of [
      "purchases: manager read",
      "audit: manager read",
      "outbox: manager read",
      "billing_customers: manager read",
      "subscriptions: manager read",
      "entitlements: manager read",
      "tax_rule_sets: manager read",
      "tax_calculations: manager read",
      "purchase_orders: manager read",
      "po_lines: manager read",
      "xero_sync_log: manager read",
      "xero_bills: manager read",
    ]) {
      expect(migration).toContain(`create policy "${policy}"`);
    }
    expect(migration).toMatch(
      /create or replace function public\.xero_connection_status[\s\S]*if not public\.is_manager\(p_restaurant_id\)/,
    );
  });

  it("keeps internal trigger and sweep functions off the RPC surface", () => {
    for (const signature of [
      "public.enforce_purchase_request_lifecycle()",
      "public.assert_valid_tax_rule_set(integer, text, date, date, text, jsonb)",
      "public.validate_tax_rule_set_row()",
      "public.process_outbox()",
    ]) {
      expect(migration).toContain(`revoke execute on function ${signature}`);
    }
  });

  it("preserves the documented multi-restaurant membership model", () => {
    expect(migration).toContain(
      "restaurant_members stays many-to-many",
    );
    expect(migration).not.toMatch(
      /alter table public\.restaurant_members[\s\S]{0,200}unique \(user_id\)/i,
    );
  });
});
