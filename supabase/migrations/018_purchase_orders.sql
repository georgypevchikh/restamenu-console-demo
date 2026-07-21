-- Purchase orders: the document layer on top of purchase_requests.
--
-- A manager groups pending requests into a PO, the tax engine prices it
-- (calculate-tax Edge Function), and create_purchase_order() persists the
-- document + lines + pricing trace in one transaction. Approval is a separate,
-- OTP-gated step (approve_purchase_order, migration 020 — it needs the
-- otp_challenges table).
--
-- All money columns are integer minor units (cents). The engine never touches
-- floats; numeric quantities are the only fractional values here.

create table public.purchase_orders (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants (id) on delete cascade,
  po_number           text not null,
  supplier_name       text not null,
  status              text not null default 'draft'
                        check (status in ('draft', 'approved', 'cancelled')),
  currency            text not null default 'EUR',
  subtotal_minor      bigint not null default 0,
  tax_total_minor     bigint not null default 0,
  withholding_minor   bigint not null default 0,
  total_minor         bigint not null default 0,
  tax_calculation_id  uuid references public.tax_calculations (id),
  created_by          uuid references public.profiles (id) on delete set null,
  approved_by         uuid references public.profiles (id) on delete set null,
  approved_at         timestamptz,
  xero_invoice_id     text,
  pdf_generated_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (restaurant_id, po_number)
);

create index purchase_orders_restaurant_idx
  on public.purchase_orders (restaurant_id, created_at desc);

create table public.purchase_order_lines (
  id                   uuid primary key default gen_random_uuid(),
  purchase_order_id    uuid not null references public.purchase_orders (id) on delete cascade,
  restaurant_id        uuid not null references public.restaurants (id) on delete cascade,
  product_id           uuid references public.products (id) on delete set null,
  request_id           uuid references public.purchase_requests (id) on delete set null,
  description          text not null,
  category_name        text,
  quantity             numeric(12,3) not null,
  unit                 text,
  unit_price_minor     bigint not null,
  line_subtotal_minor  bigint not null,
  tax_minor            bigint not null default 0,
  line_total_minor     bigint not null,
  tax_detail           jsonb
);

create index purchase_order_lines_po_idx
  on public.purchase_order_lines (purchase_order_id);

-- Per-restaurant, per-year PO numbering. The upsert is concurrency-safe: two
-- simultaneous POs serialize on the counter row and get distinct numbers.
create table public.po_counters (
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  year           int not null,
  last           int not null default 0,
  primary key (restaurant_id, year)
);

create or replace function public.next_po_number(p_restaurant_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_year int := extract(year from now())::int;
  v_last int;
begin
  insert into public.po_counters (restaurant_id, year, last)
  values (p_restaurant_id, v_year, 1)
  on conflict (restaurant_id, year) do update
    set last = public.po_counters.last + 1
  returning last into v_last;

  return 'PO-' || v_year || '-' || lpad(v_last::text, 4, '0');
end;
$$;

revoke execute on function public.next_po_number(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- RLS

alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.po_counters          enable row level security;

create policy "purchase_orders: member read" on public.purchase_orders
  for select using (public.is_member(restaurant_id));
-- Drafts can be cancelled directly; approval only ever happens through the
-- OTP-gated RPC, so a direct UPDATE cannot set status = 'approved'.
create policy "purchase_orders: manager cancel draft" on public.purchase_orders
  for update using (public.is_manager(restaurant_id) and status = 'draft')
  with check (public.is_manager(restaurant_id) and status in ('draft', 'cancelled'));

create policy "po_lines: member read" on public.purchase_order_lines
  for select using (public.is_member(restaurant_id));

-- po_counters: no user policies — only next_po_number() touches it.
-- Inserts into purchase_orders/lines go through create_purchase_order() below.

-- ---------------------------------------------------------------- create RPC

-- SECURITY DEFINER with explicit checks rather than invoker + RLS: the
-- function must also write the audit ledger and read the entitlement gate,
-- which user roles cannot touch directly. The tenant is derived from the
-- caller's own membership — never from a parameter — so a forged payload
-- cannot place a document in another restaurant.
create or replace function public.create_purchase_order(
  p_supplier_name     text,
  p_currency          text,
  p_rule_set_id       uuid,
  p_rule_set_version  int,
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
  v_restaurant_id  uuid;
  v_calc_id        uuid;
  v_po_id          uuid;
  v_po_number      text;
  v_line           jsonb;
  v_sum_subtotal   bigint := 0;
  v_sum_tax        bigint := 0;
  v_sum_total      bigint := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select restaurant_id into v_restaurant_id
  from public.restaurant_members
  where user_id = v_uid
  limit 1;

  if v_restaurant_id is null or not public.is_manager(v_restaurant_id) then
    raise exception 'manager_required';
  end if;

  if not public.has_entitlement(v_restaurant_id, 'billing_pro') then
    raise exception 'entitlement_required';
  end if;

  if p_supplier_name is null or length(trim(p_supplier_name)) = 0 then
    raise exception 'supplier_name_required';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines_required';
  end if;

  -- The engine's arithmetic is re-checked here so a tampered client cannot
  -- persist a document whose totals disagree with its own lines.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if (v_line->>'line_subtotal_minor')::bigint + (v_line->>'tax_minor')::bigint
       <> (v_line->>'line_total_minor')::bigint then
      raise exception 'line_arithmetic_mismatch';
    end if;
    v_sum_subtotal := v_sum_subtotal + (v_line->>'line_subtotal_minor')::bigint;
    v_sum_tax      := v_sum_tax      + (v_line->>'tax_minor')::bigint;
    v_sum_total    := v_sum_total    + (v_line->>'line_total_minor')::bigint;
  end loop;

  -- Lines carry subtotal + tax; withholding is document-level.
  if v_sum_subtotal <> p_subtotal_minor
     or v_sum_tax <> p_tax_total_minor
     or v_sum_total <> p_subtotal_minor + p_tax_total_minor
     or p_total_minor <> p_subtotal_minor + p_tax_total_minor - p_withholding_minor then
    raise exception 'totals_mismatch';
  end if;

  insert into public.tax_calculations
    (restaurant_id, rule_set_id, rule_set_version, document_type, input, output, trace)
  values
    (v_restaurant_id, p_rule_set_id, p_rule_set_version, 'purchase_order',
     p_calc_input, p_calc_output, p_calc_trace)
  returning id into v_calc_id;

  v_po_number := public.next_po_number(v_restaurant_id);

  insert into public.purchase_orders
    (restaurant_id, po_number, supplier_name, currency,
     subtotal_minor, tax_total_minor, withholding_minor, total_minor,
     tax_calculation_id, created_by)
  values
    (v_restaurant_id, v_po_number, trim(p_supplier_name), coalesce(p_currency, 'EUR'),
     p_subtotal_minor, p_tax_total_minor, p_withholding_minor, p_total_minor,
     v_calc_id, v_uid)
  returning id into v_po_id;

  insert into public.purchase_order_lines
    (purchase_order_id, restaurant_id, product_id, request_id, description,
     category_name, quantity, unit, unit_price_minor,
     line_subtotal_minor, tax_minor, line_total_minor, tax_detail)
  select
    v_po_id,
    v_restaurant_id,
    nullif(l->>'product_id', '')::uuid,
    nullif(l->>'request_id', '')::uuid,
    l->>'description',
    l->>'category_name',
    (l->>'quantity')::numeric,
    l->>'unit',
    (l->>'unit_price_minor')::bigint,
    (l->>'line_subtotal_minor')::bigint,
    (l->>'tax_minor')::bigint,
    (l->>'line_total_minor')::bigint,
    l->'tax_detail'
  from jsonb_array_elements(p_lines) as l;

  perform public.log_audit(
    v_restaurant_id, v_uid, 'user',
    'po.created', 'purchase_order', v_po_id,
    jsonb_build_object(
      'po_number', v_po_number,
      'supplier', trim(p_supplier_name),
      'total_minor', p_total_minor,
      'currency', coalesce(p_currency, 'EUR'),
      'lines', jsonb_array_length(p_lines)
    )
  );

  return v_po_id;
end;
$$;

revoke execute on function public.create_purchase_order(text, text, uuid, int, jsonb, jsonb, jsonb, jsonb, bigint, bigint, bigint, bigint) from public, anon;

-- Cancelling a draft is a plain status flip, but it should still leave a trail.
create or replace function public.cancel_purchase_order(p_po_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_po  record;
begin
  select id, restaurant_id, po_number, status into v_po
  from public.purchase_orders where id = p_po_id;

  if v_po.id is null or not public.is_manager(v_po.restaurant_id) then
    raise exception 'manager_required';
  end if;
  if v_po.status <> 'draft' then
    raise exception 'only_drafts_can_be_cancelled';
  end if;

  update public.purchase_orders
  set status = 'cancelled', updated_at = now()
  where id = p_po_id;

  perform public.log_audit(
    v_po.restaurant_id, v_uid, 'user',
    'po.cancelled', 'purchase_order', p_po_id,
    jsonb_build_object('po_number', v_po.po_number)
  );
end;
$$;

revoke execute on function public.cancel_purchase_order(uuid) from public, anon;

create or replace function public.set_po_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger purchase_orders_updated_at
  before update on public.purchase_orders
  for each row
  execute function public.set_po_updated_at();
