-- Forward-only database trust-boundary hardening.
--
-- This migration closes four classes of gaps left by the original MVP:
--   1. a request could point at a product owned by another restaurant;
--   2. authenticated callers could spoof request ownership/state and managers
--      could rewrite the identity of an existing request;
--   3. malformed tax JSON could become the highest effective version and take
--      purchase-order calculation offline;
--   4. the outbox attempted delivery when its authentication secret was blank.
--
-- Deliberate non-change: restaurant_members stays many-to-many. The mobile
-- product specification explicitly says that a user may belong to multiple
-- restaurants. Console routes currently call .single() and therefore need an
-- explicit active-restaurant selector; a UNIQUE(user_id) constraint would hide
-- that application bug by deleting a documented product capability.

-- ============================================================================
-- Purchase requests: tenant-consistent sources and an explicit lifecycle.

-- Category ids and legacy purchase-history request ids were individually
-- valid but could still belong to another tenant. Composite foreign keys make
-- the restaurant part of the relationship itself instead of relying on every
-- caller to repeat the same join correctly.
alter table public.categories
  add constraint categories_id_restaurant_id_key unique (id, restaurant_id);

alter table public.products
  drop constraint products_category_id_fkey;

alter table public.products
  add constraint products_category_restaurant_fkey
  foreign key (category_id, restaurant_id)
  references public.categories (id, restaurant_id)
  on delete set null (category_id)
  not valid;

-- A product id is globally unique already, but Postgres needs a matching
-- composite UNIQUE key before it can enforce that product_id and restaurant_id
-- refer to the same source row.
alter table public.products
  add constraint products_id_restaurant_id_key unique (id, restaurant_id);

alter table public.purchase_requests
  drop constraint purchase_requests_product_id_fkey;

alter table public.purchase_requests
  add constraint purchase_requests_product_restaurant_fkey
  foreign key (product_id, restaurant_id)
  references public.products (id, restaurant_id)
  on delete cascade
  not valid;

alter table public.purchase_requests
  add constraint purchase_requests_quantity_valid
  check (
    quantity > 0
    and quantity * 1000 = trunc(quantity * 1000)
    and quantity * 1000 <= 9007199254740991::numeric
  ) not valid;

-- Validate before the new policies become active. A dirty hosted database must
-- fail the migration rather than silently preserving cross-tenant source rows.
alter table public.purchase_requests
  validate constraint purchase_requests_product_restaurant_fkey;
alter table public.purchase_requests
  validate constraint purchase_requests_quantity_valid;
alter table public.products
  validate constraint products_category_restaurant_fkey;

alter table public.purchase_requests
  add constraint purchase_requests_id_restaurant_id_key
  unique (id, restaurant_id);

alter table public.purchases
  drop constraint purchases_request_id_fkey;

alter table public.purchases
  add constraint purchases_request_restaurant_fkey
  foreign key (request_id, restaurant_id)
  references public.purchase_requests (id, restaurant_id)
  on delete set null (request_id)
  not valid;

alter table public.purchases
  validate constraint purchases_request_restaurant_fkey;

-- Pricing lookup assumes one preferred supplier. Enforce that assumption at
-- the storage boundary while still allowing any number of alternatives.
create unique index suppliers_one_primary_per_product_idx
  on public.suppliers (product_id)
  where is_primary;

-- A request can be reserved by one draft/approved PO at a time. Keeping the
-- claim on the request (rather than a UNIQUE index on historical PO lines)
-- lets cancellation release it without deleting the original document line.
alter table public.purchase_requests
  add column claimed_by_po_id uuid
  references public.purchase_orders (id);

create index purchase_requests_claimed_by_po_idx
  on public.purchase_requests (claimed_by_po_id)
  where claimed_by_po_id is not null;

create or replace function public.enforce_purchase_request_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    -- Service-owned seed/import transactions have no JWT and may restore
    -- historical terminal rows. Authenticated application inserts, however,
    -- always begin as the caller's own pending request.
    if v_uid is not null then
      if new.created_by is distinct from v_uid then
        raise exception 'request_creator_must_match_authenticated_user';
      end if;
      if new.status <> 'pending' then
        raise exception 'new_request_must_be_pending';
      end if;
      if new.claimed_by_po_id is not null then
        raise exception 'new_request_cannot_be_preclaimed';
      end if;
    end if;

    if new.quantity <= 0 then
      raise exception 'request_quantity_must_be_positive';
    end if;
    if new.quantity * 1000 <> trunc(new.quantity * 1000) then
      raise exception 'request_quantity_must_have_at_most_three_decimals';
    end if;
    if new.quantity * 1000 > 9007199254740991::numeric then
      raise exception 'request_quantity_too_large';
    end if;

    return new;
  end if;

  -- Status is the only mutable domain field. In particular, a manager cannot
  -- turn an approved source row into a different product/tenant/requester or
  -- alter the quantity after it has been used to prepare a purchase order.
  if new.id is distinct from old.id
     or new.restaurant_id is distinct from old.restaurant_id
     or new.product_id is distinct from old.product_id
     or new.created_by is distinct from old.created_by
     or new.quantity is distinct from old.quantity
     or new.priority is distinct from old.priority
     or new.stock_at_request is distinct from old.stock_at_request
     or new.created_at is distinct from old.created_at then
    raise exception 'request_identity_is_immutable';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending' and new.status in ('bought', 'not_found', 'partial', 'cancelled'))
      or (old.status = 'not_found' and new.status in ('bought', 'partial', 'cancelled'))
      or (old.status = 'partial' and new.status in ('bought', 'not_found', 'cancelled'))
      or (
        old.status = 'bought'
        and new.status = 'pending'
        and old.claimed_by_po_id is not null
        and new.claimed_by_po_id is null
        and exists (
          select 1
          from public.purchase_orders po
          where po.id = old.claimed_by_po_id and po.status = 'cancelled'
        )
      )
    ) then
      raise exception 'invalid_request_status_transition:%->%', old.status, new.status;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_purchase_request_lifecycle
  on public.purchase_requests;
create trigger enforce_purchase_request_lifecycle
  before insert or update on public.purchase_requests
  for each row execute function public.enforce_purchase_request_lifecycle();

drop policy if exists "requests: member insert" on public.purchase_requests;
create policy "requests: member insert"
  on public.purchase_requests
  for insert
  with check (
    public.is_member(restaurant_id)
    and created_by = (select auth.uid())
    and status = 'pending'
    and claimed_by_po_id is null
    and quantity > 0
  );

drop policy if exists "requests: manager update" on public.purchase_requests;
create policy "requests: manager update"
  on public.purchase_requests
  for update
  using (public.is_manager(restaurant_id))
  with check (public.is_manager(restaurant_id));

-- Cancellation is a state transition, not physical deletion. Keeping the row
-- preserves request history and any purchase-order references.
drop policy if exists "requests: manager delete" on public.purchase_requests;
revoke delete on table public.purchase_requests from anon, authenticated;

-- Table-level UPDATE would include the internal claim column. Managers need
-- only the lifecycle status operation; the SECURITY DEFINER PO RPCs own claims.
revoke update on table public.purchase_requests from anon, authenticated;
grant update (status) on table public.purchase_requests to authenticated;

-- ============================================================================
-- Purchase-order RPC: bounded inputs before authoritative calculation.

alter table public.purchase_orders
  add constraint purchase_orders_text_fields_valid
  check (
    length(btrim(supplier_name)) between 1 and 200
    and currency ~ '^[A-Z]{3}$'
  ) not valid;

alter table public.purchase_order_lines
  add constraint purchase_order_lines_text_fields_valid
  check (
    length(btrim(description)) between 1 and 300
    and (category_name is null or length(category_name) <= 300)
    and (unit is null or length(unit) <= 50)
    and octet_length(coalesce(tax_detail, '{}'::jsonb)::text) <= 16384
  ) not valid;

alter table public.purchase_orders
  validate constraint purchase_orders_text_fields_valid;
alter table public.purchase_order_lines
  validate constraint purchase_order_lines_text_fields_valid;

-- Refuse to guess which historical PO owns a request if dirty data already
-- contains more than one non-cancelled use. The hosted preflight is clean.
do $$
begin
  if exists (
    select 1
    from public.purchase_order_lines pol
    join public.purchase_orders po on po.id = pol.purchase_order_id
    where pol.request_id is not null and po.status <> 'cancelled'
    group by pol.request_id
    having count(*) > 1
  ) then
    raise exception 'duplicate_active_purchase_request_lines';
  end if;
end;
$$;

-- Reconcile documents created before the claim invariant existed. Cancelled
-- POs intentionally do not reserve their requests.
update public.purchase_requests pr
set status = 'bought',
    claimed_by_po_id = active.po_id,
    updated_at = now()
from (
  select pol.request_id, max(pol.purchase_order_id::text)::uuid as po_id
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where pol.request_id is not null and po.status <> 'cancelled'
  group by pol.request_id
) active
where pr.id = active.request_id;

-- Preserve the migration-024 implementation name long enough to replace it
-- with the explicit-tenant version below, then put a fail-fast envelope around
-- that authoritative persistence path.
alter function public.create_purchase_order(
  text, text, uuid, integer, jsonb, jsonb, jsonb, jsonb,
  bigint, bigint, bigint, bigint
) rename to create_purchase_order_validated_impl;

-- Migration 024 had to guess the tenant with `LIMIT 1`. That is unsafe and
-- unusable once a manager belongs to more than one restaurant. Replace the
-- renamed implementation with an explicit-tenant variant before exposing the
-- new public wrapper. The wrapper and this internal function both authorize
-- the selected tenant; neither trusts payload-owned product/request ids.
drop function public.create_purchase_order_validated_impl(
  text, text, uuid, integer, jsonb, jsonb, jsonb, jsonb,
  bigint, bigint, bigint, bigint
);

create function public.create_purchase_order_validated_impl(
  p_restaurant_id    uuid,
  p_supplier_name     text,
  p_currency          text,
  p_rule_set_id       uuid,
  p_rule_set_version  integer,
  p_calc_input        jsonb,
  p_calc_output       jsonb,
  p_calc_trace        jsonb,
  p_lines             jsonb,
  p_subtotal_minor    bigint,
  p_tax_total_minor   bigint,
  p_withholding_minor bigint,
  p_total_minor       bigint
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := auth.uid();
  v_authoritative  jsonb;
  v_calc_id        uuid;
  v_po_id          uuid;
  v_po_number      text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_restaurant_id is null then
    raise exception 'restaurant_required';
  end if;
  if not exists (
    select 1
    from public.restaurant_members rm
    where rm.restaurant_id = p_restaurant_id
      and rm.user_id = v_uid
      and rm.role = 'manager'
  ) then
    raise exception 'manager_required';
  end if;
  if not public.has_entitlement(p_restaurant_id, 'billing_pro') then
    raise exception 'entitlement_required';
  end if;
  if p_supplier_name is null or length(trim(p_supplier_name)) = 0 then
    raise exception 'supplier_name_required';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or p_calc_output is null or jsonb_typeof(p_calc_output) <> 'object'
     or p_calc_trace is null or jsonb_typeof(p_calc_trace) <> 'array' then
    raise exception 'invalid_calculation_payload';
  end if;

  v_authoritative := public.calculate_purchase_order_authoritative(
    p_restaurant_id,
    p_rule_set_id,
    p_rule_set_version,
    p_calc_input
  );

  if jsonb_array_length(p_lines) <> jsonb_array_length(v_authoritative->'lines') then
    raise exception 'lines_mismatch';
  end if;
  if p_subtotal_minor is distinct from (v_authoritative->>'subtotal_minor')::bigint
     or p_tax_total_minor is distinct from (v_authoritative->>'tax_total_minor')::bigint
     or p_withholding_minor is distinct from (v_authoritative->>'withholding_minor')::bigint
     or p_total_minor is distinct from (v_authoritative->>'total_minor')::bigint then
    raise exception 'totals_mismatch';
  end if;
  if coalesce(p_calc_output->>'subtotal_minor', '') !~ '^\d+$'
     or coalesce(p_calc_output->>'tax_total_minor', '') !~ '^\d+$'
     or coalesce(p_calc_output->>'withholding_minor', '') !~ '^\d+$'
     or coalesce(p_calc_output->>'total_minor', '') !~ '^\d+$'
     or (p_calc_output->>'subtotal_minor')::bigint <> (v_authoritative->>'subtotal_minor')::bigint
     or (p_calc_output->>'tax_total_minor')::bigint <> (v_authoritative->>'tax_total_minor')::bigint
     or (p_calc_output->>'withholding_minor')::bigint <> (v_authoritative->>'withholding_minor')::bigint
     or (p_calc_output->>'total_minor')::bigint <> (v_authoritative->>'total_minor')::bigint then
    raise exception 'calculation_output_mismatch';
  end if;

  insert into public.tax_calculations
    (restaurant_id, rule_set_id, rule_set_version, document_type, input, output, trace)
  values
    (
      p_restaurant_id,
      p_rule_set_id,
      p_rule_set_version,
      'purchase_order',
      v_authoritative->'input',
      jsonb_build_object(
        'subtotal_minor', (v_authoritative->>'subtotal_minor')::bigint,
        'tax_total_minor', (v_authoritative->>'tax_total_minor')::bigint,
        'withholding_minor', (v_authoritative->>'withholding_minor')::bigint,
        'total_minor', (v_authoritative->>'total_minor')::bigint
      ),
      v_authoritative->'trace'
    )
  returning id into v_calc_id;

  v_po_number := public.next_po_number(p_restaurant_id);

  insert into public.purchase_orders
    (restaurant_id, po_number, supplier_name, currency,
     subtotal_minor, tax_total_minor, withholding_minor, total_minor,
     tax_calculation_id, created_by)
  values
    (
      p_restaurant_id,
      v_po_number,
      trim(p_supplier_name),
      p_currency,
      (v_authoritative->>'subtotal_minor')::bigint,
      (v_authoritative->>'tax_total_minor')::bigint,
      (v_authoritative->>'withholding_minor')::bigint,
      (v_authoritative->>'total_minor')::bigint,
      v_calc_id,
      v_uid
    )
  returning id into v_po_id;

  insert into public.purchase_order_lines
    (purchase_order_id, restaurant_id, product_id, request_id, description,
     category_name, quantity, unit, unit_price_minor,
     line_subtotal_minor, tax_minor, line_total_minor, tax_detail)
  select
    v_po_id,
    p_restaurant_id,
    nullif(line->>'product_id', '')::uuid,
    nullif(line->>'request_id', '')::uuid,
    line->>'description',
    line->>'category_name',
    (line->>'quantity')::numeric,
    line->>'unit',
    (line->>'unit_price_minor')::bigint,
    (line->>'line_subtotal_minor')::bigint,
    (line->>'tax_minor')::bigint,
    (line->>'line_total_minor')::bigint,
    line->'tax_detail'
  from jsonb_array_elements(v_authoritative->'lines') as line;

  perform public.log_audit(
    p_restaurant_id, v_uid, 'user',
    'po.created', 'purchase_order', v_po_id,
    jsonb_build_object(
      'po_number', v_po_number,
      'supplier', trim(p_supplier_name),
      'total_minor', (v_authoritative->>'total_minor')::bigint,
      'currency', p_currency,
      'lines', jsonb_array_length(v_authoritative->'lines'),
      'calculation_authority', 'postgres'
    )
  );

  return v_po_id;
end;
$$;

create or replace function public.create_purchase_order(
  p_restaurant_id    uuid,
  p_supplier_name     text,
  p_currency          text,
  p_rule_set_id       uuid,
  p_rule_set_version  integer,
  p_calc_input        jsonb,
  p_calc_output       jsonb,
  p_calc_trace        jsonb,
  p_lines             jsonb,
  p_subtotal_minor    bigint,
  p_tax_total_minor   bigint,
  p_withholding_minor bigint,
  p_total_minor       bigint
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_line jsonb;
  v_po_id uuid;
  v_request_line_count integer;
  v_distinct_request_count integer;
  v_claimed_count integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_restaurant_id is null then
    raise exception 'restaurant_required';
  end if;
  if not exists (
    select 1
    from public.restaurant_members rm
    where rm.restaurant_id = p_restaurant_id
      and rm.user_id = v_uid
      and rm.role = 'manager'
  ) then
    raise exception 'manager_required';
  end if;
  if not public.has_entitlement(p_restaurant_id, 'billing_pro') then
    raise exception 'entitlement_required';
  end if;

  if p_supplier_name is null
     or length(btrim(p_supplier_name)) = 0
     or length(p_supplier_name) > 200 then
    raise exception 'invalid_supplier_name';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;

  if p_calc_input is null
     or jsonb_typeof(p_calc_input) <> 'object'
     or octet_length(p_calc_input::text) > 262144 then
    raise exception 'invalid_calculation_input';
  end if;
  if jsonb_typeof(p_calc_input->'lines') is distinct from 'array' then
    raise exception 'invalid_calculation_input';
  end if;
  if jsonb_array_length(p_calc_input->'lines') not between 1 and 250 then
    raise exception 'invalid_calculation_input';
  end if;
  if p_calc_output is null
     or jsonb_typeof(p_calc_output) <> 'object'
     or octet_length(p_calc_output::text) > 65536 then
    raise exception 'invalid_calculation_output';
  end if;
  if p_calc_trace is null
     or jsonb_typeof(p_calc_trace) <> 'array'
     or octet_length(p_calc_trace::text) > 524288 then
    raise exception 'invalid_calculation_trace';
  end if;
  if p_lines is null
     or jsonb_typeof(p_lines) <> 'array'
     or octet_length(p_lines::text) > 524288 then
    raise exception 'invalid_purchase_order_lines';
  end if;
  if jsonb_array_length(p_lines) not between 1 and 250 then
    raise exception 'invalid_purchase_order_lines';
  end if;

  for v_line in
    select value
    from jsonb_array_elements(p_calc_input->'lines') as input_lines(value)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line->'description') is distinct from 'string'
       or length(btrim(v_line->>'description')) = 0
       or length(v_line->>'description') > 300 then
      raise exception 'invalid_line_description';
    end if;
    if v_line ? 'category_name'
       and v_line->'category_name' <> 'null'::jsonb
       and (
         jsonb_typeof(v_line->'category_name') is distinct from 'string'
         or length(v_line->>'category_name') > 300
       ) then
      raise exception 'invalid_line_category';
    end if;
    if v_line ? 'unit'
       and v_line->'unit' <> 'null'::jsonb
       and (
         jsonb_typeof(v_line->'unit') is distinct from 'string'
         or length(v_line->>'unit') > 50
       ) then
      raise exception 'invalid_line_unit';
    end if;
  end loop;

  v_po_id := public.create_purchase_order_validated_impl(
    p_restaurant_id,
    p_supplier_name,
    p_currency,
    p_rule_set_id,
    p_rule_set_version,
    p_calc_input,
    p_calc_output,
    p_calc_trace,
    p_lines,
    p_subtotal_minor,
    p_tax_total_minor,
    p_withholding_minor,
    p_total_minor
  );

  select count(pol.request_id), count(distinct pol.request_id)
  into v_request_line_count, v_distinct_request_count
  from public.purchase_order_lines pol
  where pol.purchase_order_id = v_po_id;

  if v_request_line_count <> v_distinct_request_count then
    raise exception 'duplicate_request_in_purchase_order';
  end if;

  update public.purchase_requests pr
  set claimed_by_po_id = v_po_id,
      status = 'bought',
      updated_at = now()
  from public.purchase_order_lines pol
  where pol.purchase_order_id = v_po_id
    and pol.request_id = pr.id
    and pr.claimed_by_po_id is null
    and pr.status = 'pending';
  get diagnostics v_claimed_count = row_count;

  if v_claimed_count <> v_distinct_request_count then
    -- Raising rolls back the inner function's PO, lines, tax calculation,
    -- counter increment and audit entry together with this failed claim.
    raise exception 'purchase_request_claim_conflict';
  end if;

  return v_po_id;
end;
$$;

-- Cancellation and request release are one transaction. The original locked
-- compare-and-set implementation remains the internal state transition.
alter function public.cancel_purchase_order(uuid)
  rename to cancel_purchase_order_without_request_release;

create or replace function public.cancel_purchase_order(p_po_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.cancel_purchase_order_without_request_release(p_po_id);

  update public.purchase_requests pr
  set status = 'pending',
      claimed_by_po_id = null,
      updated_at = now()
  where pr.claimed_by_po_id = p_po_id;
end;
$$;

-- ============================================================================
-- Tax rule sets: validate the JSON at the storage boundary.

alter table public.tax_rule_sets
  add constraint tax_rule_sets_version_positive
  check (version > 0) not valid;
alter table public.tax_rule_sets
  add constraint tax_rule_sets_name_valid
  check (length(btrim(name)) between 1 and 300) not valid;
alter table public.tax_rule_sets
  add constraint tax_rule_sets_date_range_valid
  check (effective_to is null or effective_to >= effective_from) not valid;
alter table public.tax_rule_sets
  add constraint tax_rule_sets_rules_envelope_valid
  check (
    jsonb_typeof(rules) = 'array'
    and jsonb_array_length(rules) <= 100
    and octet_length(rules::text) <= 262144
  ) not valid;

alter table public.tax_rule_sets validate constraint tax_rule_sets_version_positive;
alter table public.tax_rule_sets validate constraint tax_rule_sets_name_valid;
alter table public.tax_rule_sets validate constraint tax_rule_sets_date_range_valid;
alter table public.tax_rule_sets validate constraint tax_rule_sets_rules_envelope_valid;

create or replace function public.assert_valid_tax_rule_set(
  p_version integer,
  p_name text,
  p_effective_from date,
  p_effective_to date,
  p_rounding_mode text,
  p_rules jsonb
) returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_rule jsonb;
  v_category jsonb;
  v_category_name text;
  v_rate numeric;
  v_threshold numeric;
  v_default_vat_count integer := 0;
  v_withholding_count integer := 0;
  v_seen_categories text[] := array[]::text[];
begin
  if p_version is null or p_version <= 0 then
    raise exception 'invalid_tax_rule_set:version';
  end if;
  if p_name is null
     or length(btrim(p_name)) = 0
     or length(p_name) > 300 then
    raise exception 'invalid_tax_rule_set:name';
  end if;
  if p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from) then
    raise exception 'invalid_tax_rule_set:effective_dates';
  end if;
  if p_rounding_mode not in ('half_up', 'bankers') then
    raise exception 'invalid_tax_rule_set:rounding_mode';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception 'invalid_tax_rule_set:rules_envelope';
  end if;
  if jsonb_array_length(p_rules) > 100
     or octet_length(p_rules::text) > 262144 then
    raise exception 'invalid_tax_rule_set:rules_envelope';
  end if;

  for v_rule in
    select value from jsonb_array_elements(p_rules) as rules(value)
  loop
    if jsonb_typeof(v_rule) <> 'object' then
      raise exception 'invalid_tax_rule_set:rule_not_object';
    end if;
    if jsonb_typeof(v_rule->'name') is distinct from 'string'
       or length(btrim(v_rule->>'name')) = 0
       or length(v_rule->>'name') > 300 then
      raise exception 'invalid_tax_rule_set:rule_name';
    end if;
    if jsonb_typeof(v_rule->'rate_bps') is distinct from 'number' then
      raise exception 'invalid_tax_rule_set:rate_bps';
    end if;

    v_rate := (v_rule->>'rate_bps')::numeric;
    if v_rate <> trunc(v_rate) or v_rate < 0 or v_rate > 10000 then
      raise exception 'invalid_tax_rule_set:rate_bps';
    end if;

    if v_rule->>'kind' = 'vat' then
      if v_rule->>'applies_to' = 'default' then
        v_default_vat_count := v_default_vat_count + 1;
      elsif v_rule->>'applies_to' = 'categories' then
        if jsonb_typeof(v_rule->'categories') is distinct from 'array' then
          raise exception 'invalid_tax_rule_set:categories';
        end if;
        if jsonb_array_length(v_rule->'categories') = 0
           or jsonb_array_length(v_rule->'categories') > 250 then
          raise exception 'invalid_tax_rule_set:categories';
        end if;

        for v_category in
          select value
          from jsonb_array_elements(v_rule->'categories') as categories(value)
        loop
          if jsonb_typeof(v_category) <> 'string' then
            raise exception 'invalid_tax_rule_set:category_name';
          end if;
          v_category_name := btrim(v_category #>> '{}');
          if length(v_category_name) = 0 or length(v_category_name) > 300 then
            raise exception 'invalid_tax_rule_set:category_name';
          end if;
          if v_category_name = any(v_seen_categories) then
            raise exception 'invalid_tax_rule_set:duplicate_category:%', v_category_name;
          end if;
          v_seen_categories := array_append(v_seen_categories, v_category_name);
        end loop;
      else
        raise exception 'invalid_tax_rule_set:vat_applies_to';
      end if;
    elsif v_rule->>'kind' = 'withholding' then
      v_withholding_count := v_withholding_count + 1;
      if jsonb_typeof(v_rule->'threshold_minor') is distinct from 'number' then
        raise exception 'invalid_tax_rule_set:threshold_minor';
      end if;
      v_threshold := (v_rule->>'threshold_minor')::numeric;
      if v_threshold <> trunc(v_threshold)
         or v_threshold < 0
         or v_threshold > 9007199254740991::numeric then
        raise exception 'invalid_tax_rule_set:threshold_minor';
      end if;
    else
      raise exception 'invalid_tax_rule_set:unsupported_kind';
    end if;
  end loop;

  if v_default_vat_count > 1 then
    raise exception 'invalid_tax_rule_set:multiple_default_vat_rules';
  end if;
  if v_withholding_count > 1 then
    raise exception 'invalid_tax_rule_set:multiple_withholding_rules';
  end if;
end;
$$;

create or replace function public.validate_tax_rule_set_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_valid_tax_rule_set(
    new.version,
    new.name,
    new.effective_from,
    new.effective_to,
    new.rounding_mode,
    new.rules
  );
  return new;
end;
$$;

drop trigger if exists validate_tax_rule_set_row on public.tax_rule_sets;
create trigger validate_tax_rule_set_row
  before insert or update on public.tax_rule_sets
  for each row execute function public.validate_tax_rule_set_row();

-- Effective-window overlap is intentional in this versioned model: both the
-- Edge engine and authoritative SQL choose the highest effective version. It
-- lets a future version start while the previous open-ended version remains an
-- immutable historical record. Dates themselves are still strictly validated.

-- Triggers validate future writes; explicitly validate every historical row as
-- well so a malformed pre-migration version cannot remain selectable.
do $$
declare
  r record;
begin
  for r in
    select version, name, effective_from, effective_to, rounding_mode, rules
    from public.tax_rule_sets
  loop
    perform public.assert_valid_tax_rule_set(
      r.version,
      r.name,
      r.effective_from,
      r.effective_to,
      r.rounding_mode,
      r.rules
    );
  end loop;
end;
$$;

drop policy if exists "tax_rule_sets: manager insert" on public.tax_rule_sets;
create policy "tax_rule_sets: manager insert"
  on public.tax_rule_sets
  for insert
  with check (
    public.is_manager(restaurant_id)
    and created_by = (select auth.uid())
  );

-- Calculation rows are written only by the authoritative PO RPC. Leaving a
-- dormant INSERT policy behind would become a privilege-escalation footgun if
-- someone later re-granted table INSERT.
drop policy if exists "tax_calculations: manager insert" on public.tax_calculations;
revoke insert, update, delete on table public.tax_calculations from anon, authenticated;
revoke update, delete on table public.tax_rule_sets from anon, authenticated;
revoke insert on table public.tax_rule_sets from anon;

-- ============================================================================
-- OTP issuance: authenticated identity/tenant limits are authoritative.

create index otp_challenges_user_created_idx
  on public.otp_challenges (user_id, created_at desc);
create index otp_challenges_restaurant_created_idx
  on public.otp_challenges (restaurant_id, created_at desc);

create or replace function public.issue_otp_challenge(
  p_restaurant_id uuid,
  p_user_id uuid,
  p_phone text,
  p_channel text,
  p_purpose text,
  p_reference_id uuid,
  p_code_hash text,
  p_salt text,
  p_expires_at timestamptz,
  p_ip text,
  p_provider text
) returns table (
  outcome text,
  challenge_id uuid,
  retry_after_seconds int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone           text := btrim(p_phone);
  v_ip              text := nullif(lower(btrim(coalesce(p_ip, ''))), '');
  v_last_at         timestamptz;
  v_user_hour       integer;
  v_restaurant_hour integer;
  v_phone_hour      integer;
  v_ip_hour         integer;
  v_challenge_id    uuid;
begin
  if v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid_phone';
  end if;
  if p_channel not in ('sms', 'whatsapp') then
    raise exception 'invalid_channel';
  end if;
  if p_purpose <> 'approve_po' then
    raise exception 'invalid_otp_purpose';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$'
     or p_salt is null or p_salt !~ '^[0-9a-f]{32}$' then
    raise exception 'invalid_otp_secret_material';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    raise exception 'invalid_otp_expiry';
  end if;
  if p_provider is null
     or length(btrim(p_provider)) = 0
     or length(p_provider) > 100 then
    raise exception 'invalid_provider';
  end if;
  if v_ip is not null and length(v_ip) > 64 then
    -- Proxy headers are attacker-influenced and supplemental only. Discard an
    -- implausible value rather than storing/locking an unbounded string.
    v_ip := null;
  end if;
  if not exists (
    select 1 from public.restaurant_members rm
    where rm.restaurant_id = p_restaurant_id
      and rm.user_id = p_user_id
      and rm.role = 'manager'
  ) then
    raise exception 'manager_required';
  end if;
  if not exists (
    select 1 from public.purchase_orders po
    where po.id = p_reference_id
      and po.restaurant_id = p_restaurant_id
      and po.status = 'draft'
  ) then
    raise exception 'po_not_draft_or_not_owned';
  end if;

  -- All callers acquire every bucket in this order. User/restaurant buckets
  -- cannot be evaded by rotating phone numbers or spoofing proxy headers.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('otp-restaurant:' || p_restaurant_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('otp-user:' || p_user_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('otp-phone:' || v_phone, 0)
  );
  if v_ip is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('otp-ip:' || v_ip, 0)
    );
  end if;

  select count(*) into v_user_hour
  from public.otp_challenges c
  where c.user_id = p_user_id
    and c.created_at > now() - interval '1 hour';
  if v_user_hour >= 5 then
    return query select 'user_hourly_limit'::text, null::uuid, null::integer;
    return;
  end if;

  select count(*) into v_restaurant_hour
  from public.otp_challenges c
  where c.restaurant_id = p_restaurant_id
    and c.created_at > now() - interval '1 hour';
  if v_restaurant_hour >= 20 then
    return query select 'restaurant_hourly_limit'::text, null::uuid, null::integer;
    return;
  end if;

  select max(c.created_at),
         count(*) filter (where c.created_at > now() - interval '1 hour')
  into v_last_at, v_phone_hour
  from public.otp_challenges c
  where c.phone = v_phone;

  if v_last_at is not null and v_last_at > now() - interval '60 seconds' then
    return query select
      'cooldown'::text,
      null::uuid,
      greatest(
        1,
        ceil(extract(epoch from (v_last_at + interval '60 seconds' - now())))::integer
      );
    return;
  end if;
  if v_phone_hour >= 5 then
    return query select 'phone_hourly_limit'::text, null::uuid, null::integer;
    return;
  end if;

  if v_ip is not null then
    select count(*) into v_ip_hour
    from public.otp_challenges c
    where c.created_ip = v_ip
      and c.created_at > now() - interval '1 hour';
    if v_ip_hour >= 10 then
      return query select 'ip_hourly_limit'::text, null::uuid, null::integer;
      return;
    end if;
  end if;

  insert into public.otp_challenges
    (restaurant_id, user_id, phone, channel, purpose, reference_id,
     code_hash, salt, expires_at, created_ip, provider)
  values
    (p_restaurant_id, p_user_id, v_phone, p_channel, p_purpose, p_reference_id,
     p_code_hash, p_salt, p_expires_at, v_ip, btrim(p_provider))
  returning id into v_challenge_id;

  return query select 'issued'::text, v_challenge_id, null::integer;
end;
$$;

-- Superseded by the atomic issuance RPC; keeping this preflight oracle callable
-- would invite future code to reintroduce a check-then-insert race.
revoke execute on function public.check_otp_rate_limit(text, text)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- Urgent requests: one durable transactional path through the outbox.

-- The migration-011 trigger called pg_net directly. That delivery had no
-- authenticated header, durable retry state or reconciliation, and would now
-- duplicate the outbox route. Keep the trigger name so seed.sql can continue
-- disabling synthetic alerts while replacing its implementation completely.
drop trigger if exists urgent_request_alert on public.purchase_requests;
drop function if exists public.notify_urgent_request();

create or replace function public.queue_urgent_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  select jsonb_build_object(
    'requestId', new.id,
    'quantity', new.quantity,
    'priority', new.priority,
    'status', new.status,
    'createdAt', new.created_at,
    'productName', p.name,
    'productUnit', p.unit,
    'restaurantName', r.name,
    'requestedBy', coalesce(prof.full_name, 'Unknown')
  )
  into v_payload
  from public.products p
  join public.restaurants r on r.id = new.restaurant_id
  left join public.profiles prof on prof.id = new.created_by
  where p.id = new.product_id and p.restaurant_id = new.restaurant_id;

  if v_payload is null then
    raise exception 'urgent_request_payload_source_missing';
  end if;

  perform public.emit_outbox_event(
    new.restaurant_id,
    'request.urgent',
    v_payload
  );

  return null;
end;
$$;

create trigger urgent_request_alert
  after insert on public.purchase_requests
  for each row
  when (new.priority = 'urgent')
  execute function public.queue_urgent_request();

-- ============================================================================
-- Outbox: authenticated delivery is all-or-nothing.

create or replace function public.process_outbox()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_auth  text;
  v_count int := 0;
  r       record;
  v_req   bigint;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'n8n_outbox_webhook_url';

  select decrypted_secret into v_auth
  from vault.decrypted_secrets where name = 'n8n_outbox_auth';

  -- Never emit an unauthenticated request, and do not burn retry attempts while
  -- setup is incomplete. Blank Vault values are treated as missing secrets.
  if nullif(btrim(v_url), '') is null
     or nullif(btrim(v_auth), '') is null then
    return 0;
  end if;

  for r in
    select id, restaurant_id, event_type, payload
    from public.outbox_events
    where status = 'pending'
      and attempts < max_attempts
      and next_attempt_at <= now()
    order by created_at
    limit 20
    for update skip locked
  loop
    v_req := net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', v_auth
      ),
      body    := jsonb_build_object(
        'eventId',      r.id,
        'eventType',    r.event_type,
        'restaurantId', r.restaurant_id,
        'payload',      r.payload
      ),
      timeout_milliseconds := 8000
    );

    update public.outbox_events
    set status          = 'delivering',
        attempts        = attempts + 1,
        http_request_id = v_req,
        last_attempt_at = now()
    where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ============================================================================
-- RLS cleanup: Team may browse inventory and its own requests. Financial,
-- accounting, delivery and audit surfaces are manager-only. Keep one
-- permissive policy per command and use init-plan auth lookups where direct.

drop policy if exists "requests: member read" on public.purchase_requests;
create policy "requests: manager all or team own read"
  on public.purchase_requests
  for select
  using (
    public.is_manager(restaurant_id)
    or (
      public.is_member(restaurant_id)
      and created_by = (select auth.uid())
    )
  );

drop policy if exists "purchases: member read" on public.purchases;
create policy "purchases: manager read"
  on public.purchases
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "audit: member read" on public.audit_events;
create policy "audit: manager read"
  on public.audit_events
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "outbox: member read" on public.outbox_events;
create policy "outbox: manager read"
  on public.outbox_events
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "billing_customers: member read" on public.billing_customers;
create policy "billing_customers: manager read"
  on public.billing_customers
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "subscriptions: member read" on public.subscriptions;
create policy "subscriptions: manager read"
  on public.subscriptions
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "entitlements: member read" on public.entitlements;
create policy "entitlements: manager read"
  on public.entitlements
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "tax_rule_sets: member read" on public.tax_rule_sets;
create policy "tax_rule_sets: manager read"
  on public.tax_rule_sets
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "tax_calculations: member read" on public.tax_calculations;
create policy "tax_calculations: manager read"
  on public.tax_calculations
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "purchase_orders: member read" on public.purchase_orders;
create policy "purchase_orders: manager read"
  on public.purchase_orders
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "po_lines: member read" on public.purchase_order_lines;
create policy "po_lines: manager read"
  on public.purchase_order_lines
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "xero_sync_log: member read" on public.xero_sync_log;
create policy "xero_sync_log: manager read"
  on public.xero_sync_log
  for select
  using (public.is_manager(restaurant_id));

drop policy if exists "xero_bills: member read" on public.xero_bills;
create policy "xero_bills: manager read"
  on public.xero_bills
  for select
  using (public.is_manager(restaurant_id));

-- The status RPC is SECURITY DEFINER because token rows are deny-all. Its
-- metadata is still an accounting surface, so membership alone is not enough.
create or replace function public.xero_connection_status(p_restaurant_id uuid)
returns table (
  connected         boolean,
  tenant_name       text,
  access_expires_at timestamptz,
  status            text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_manager(p_restaurant_id) then
    raise exception 'manager_required';
  end if;

  return query
  select
    (c.status = 'connected'),
    c.xero_tenant_name,
    c.access_expires_at,
    c.status
  from public.xero_connections c
  where c.restaurant_id = p_restaurant_id;
end;
$$;

drop policy if exists "profiles: own read" on public.profiles;
drop policy if exists "profiles: teammate read" on public.profiles;
create policy "profiles: own or teammate read"
  on public.profiles
  for select
  using (
    id = (select auth.uid())
    or public.shares_restaurant_with(id)
  );

drop policy if exists "profiles: own update" on public.profiles;
create policy "profiles: own update"
  on public.profiles
  for update
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- The old FOR ALL manager policy was also a second permissive SELECT policy.
-- Split only the write commands; member read remains the sole SELECT policy.
drop policy if exists "suppliers: manager write" on public.suppliers;
create policy "suppliers: manager insert"
  on public.suppliers
  for insert
  with check (
    exists (
      select 1 from public.products p
      where p.id = product_id and public.is_manager(p.restaurant_id)
    )
  );
create policy "suppliers: manager update"
  on public.suppliers
  for update
  using (
    exists (
      select 1 from public.products p
      where p.id = product_id and public.is_manager(p.restaurant_id)
    )
  )
  with check (
    exists (
      select 1 from public.products p
      where p.id = product_id and public.is_manager(p.restaurant_id)
    )
  );
create policy "suppliers: manager delete"
  on public.suppliers
  for delete
  using (
    exists (
      select 1 from public.products p
      where p.id = product_id and public.is_manager(p.restaurant_id)
    )
  );

drop policy if exists "notifications: own read" on public.notifications;
create policy "notifications: own read"
  on public.notifications
  for select
  using (recipient_id = (select auth.uid()));

drop policy if exists "notifications: own update" on public.notifications;
create policy "notifications: own update"
  on public.notifications
  for update
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

-- ============================================================================
-- Internal function ACLs. Trigger functions are invoked by Postgres, and the
-- outbox sweep by pg_cron; none is a client-callable RPC.

revoke execute on function public.enforce_purchase_request_lifecycle()
  from public, anon, authenticated, service_role;
revoke execute on function public.create_purchase_order_validated_impl(
  uuid, text, text, uuid, integer, jsonb, jsonb, jsonb, jsonb,
  bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;
revoke execute on function public.create_purchase_order(
  uuid, text, text, uuid, integer, jsonb, jsonb, jsonb, jsonb,
  bigint, bigint, bigint, bigint
) from public, anon, service_role;
grant execute on function public.create_purchase_order(
  uuid, text, text, uuid, integer, jsonb, jsonb, jsonb, jsonb,
  bigint, bigint, bigint, bigint
) to authenticated;
revoke execute on function public.cancel_purchase_order_without_request_release(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.cancel_purchase_order(uuid)
  from public, anon, service_role;
grant execute on function public.cancel_purchase_order(uuid) to authenticated;
revoke execute on function public.assert_valid_tax_rule_set(integer, text, date, date, text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_tax_rule_set_row()
  from public, anon, authenticated, service_role;
revoke execute on function public.queue_urgent_request()
  from public, anon, authenticated, service_role;
revoke execute on function public.process_outbox()
  from public, anon, authenticated, service_role;
revoke execute on function public.xero_connection_status(uuid)
  from public, anon, service_role;
grant execute on function public.xero_connection_status(uuid) to authenticated;
revoke execute on function public.issue_otp_challenge(
  uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.issue_otp_challenge(
  uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text
) to service_role;
