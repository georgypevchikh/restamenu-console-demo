-- Forward-only hardening for purchase-order pricing, OTP verification and
-- function ACLs. Migrations 014-022 are already applied to the hosted demo;
-- this migration corrects that database without rewriting history.

-- ============================================================================
-- Data invariants: privileged code is not the only line of defence.

alter table public.purchase_orders
  add constraint purchase_orders_amounts_nonnegative
  check (
    subtotal_minor >= 0
    and tax_total_minor >= 0
    and withholding_minor >= 0
    and total_minor >= 0
  ) not valid;

alter table public.purchase_orders
  add constraint purchase_orders_total_consistent
  check (total_minor = subtotal_minor + tax_total_minor - withholding_minor) not valid;

alter table public.purchase_order_lines
  add constraint purchase_order_lines_values_valid
  check (
    quantity > 0
    and unit_price_minor >= 0
    and line_subtotal_minor >= 0
    and tax_minor >= 0
    and line_total_minor >= 0
    and line_total_minor = line_subtotal_minor + tax_minor
  ) not valid;

alter table public.otp_challenges
  add constraint otp_challenges_attempts_valid
  check (max_attempts > 0 and attempts >= 0 and attempts <= max_attempts) not valid;

alter table public.purchase_orders validate constraint purchase_orders_amounts_nonnegative;
alter table public.purchase_orders validate constraint purchase_orders_total_consistent;
alter table public.purchase_order_lines validate constraint purchase_order_lines_values_valid;
alter table public.otp_challenges validate constraint otp_challenges_attempts_valid;

-- The old "manager cancel draft" UPDATE policy also allowed changing every
-- price/document column on a draft. Cancellation now goes only through the
-- locked SECURITY DEFINER RPC below; users retain tenant-scoped SELECT only.
drop policy if exists "purchase_orders: manager cancel draft" on public.purchase_orders;
revoke insert, update, delete on public.purchase_orders from anon, authenticated;
revoke insert, update, delete on public.purchase_order_lines from anon, authenticated;
revoke insert, update, delete on public.tax_calculations from anon, authenticated;

-- ============================================================================
-- Exact non-negative rounding primitives used by the authoritative SQL
-- calculation. Inputs are numeric to avoid bigint multiplication overflow.

create or replace function public.round_nonnegative_ratio(
  p_numerator numeric,
  p_denominator bigint,
  p_mode text
) returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_quotient  numeric;
  v_remainder numeric;
begin
  if p_numerator < 0 or p_denominator <= 0 then
    raise exception 'invalid_rounding_input';
  end if;
  if p_mode not in ('half_up', 'bankers') then
    raise exception 'invalid_rounding_mode';
  end if;

  v_quotient := trunc(p_numerator / p_denominator);
  v_remainder := mod(p_numerator, p_denominator);

  if v_remainder * 2 > p_denominator then
    return (v_quotient + 1)::bigint;
  elsif v_remainder * 2 < p_denominator then
    return v_quotient::bigint;
  elsif p_mode = 'half_up' or mod(v_quotient, 2) = 1 then
    return (v_quotient + 1)::bigint;
  end if;

  return v_quotient::bigint;
end;
$$;

-- Recompute a PO from tenant-owned source rows and the currently effective
-- rule set. Client-supplied category/name/unit fields are never tax authority:
-- when a product/request id exists, those values come from Postgres. Manual
-- lines are allowed, but receive the default VAT rule only.
create or replace function public.calculate_purchase_order_authoritative(
  p_restaurant_id uuid,
  p_rule_set_id uuid,
  p_rule_set_version int,
  p_input jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule_set          record;
  v_input_lines       jsonb;
  v_input_line        jsonb;
  v_normalized_input  jsonb := '[]'::jsonb;
  v_calculated_lines  jsonb := '[]'::jsonb;
  v_trace             jsonb := '[]'::jsonb;
  v_product_id        uuid;
  v_request_id        uuid;
  v_product            record;
  v_request            record;
  v_description       text;
  v_category          text;
  v_unit              text;
  v_quantity_text     text;
  v_quantity          numeric;
  v_quantity_milli    bigint;
  v_unit_price_text   text;
  v_unit_price        bigint;
  v_line_subtotal     bigint;
  v_tax_minor         bigint;
  v_line_total        bigint;
  v_vat_rule          jsonb;
  v_vat_rate          bigint;
  v_vat_name          text;
  v_withholding_rule  jsonb;
  v_withholding_rate  bigint;
  v_withholding_limit bigint;
  v_subtotal          bigint := 0;
  v_tax_total         bigint := 0;
  v_withholding       bigint := 0;
  v_total             bigint;
begin
  if p_restaurant_id is null then
    raise exception 'restaurant_required';
  end if;

  v_input_lines := p_input->'lines';
  if v_input_lines is null
     or jsonb_typeof(v_input_lines) <> 'array'
     or jsonb_array_length(v_input_lines) = 0 then
    raise exception 'calculation_input_lines_required';
  end if;

  -- The server, not the caller, chooses the effective version. The supplied
  -- id/version are assertions that the Edge response has not gone stale.
  select rs.id, rs.version, rs.name, rs.rounding_mode, rs.rules,
         rs.effective_from, rs.effective_to
  into v_rule_set
  from public.tax_rule_sets rs
  where rs.restaurant_id = p_restaurant_id
    and rs.effective_from <= current_date
    and (rs.effective_to is null or rs.effective_to >= current_date)
  order by rs.version desc
  limit 1;

  if v_rule_set.id is null then
    raise exception 'no_effective_rule_set';
  end if;
  if p_rule_set_id is distinct from v_rule_set.id
     or p_rule_set_version is distinct from v_rule_set.version then
    raise exception 'rule_set_mismatch';
  end if;
  if v_rule_set.rounding_mode not in ('half_up', 'bankers')
     or jsonb_typeof(v_rule_set.rules) <> 'array' then
    raise exception 'invalid_rule_set';
  end if;

  v_trace := jsonb_build_array(jsonb_build_object(
    'step', 'rule_set_selected',
    'detail', jsonb_build_object(
      'id', v_rule_set.id,
      'version', v_rule_set.version,
      'name', v_rule_set.name,
      'rounding_mode', v_rule_set.rounding_mode,
      'rounding_scope', 'per_line',
      'selected_by', 'postgres_current_date'
    )
  ));

  for v_input_line in select value from jsonb_array_elements(v_input_lines)
  loop
    if jsonb_typeof(v_input_line) <> 'object' then
      raise exception 'invalid_line';
    end if;

    v_product_id := null;
    v_request_id := null;
    begin
      if nullif(v_input_line->>'product_id', '') is not null then
        v_product_id := (v_input_line->>'product_id')::uuid;
      end if;
      if nullif(v_input_line->>'request_id', '') is not null then
        v_request_id := (v_input_line->>'request_id')::uuid;
      end if;
    exception when invalid_text_representation then
      raise exception 'invalid_source_id';
    end;

    v_quantity_text := v_input_line->>'quantity';
    if v_quantity_text is null or v_quantity_text !~ '^\d+(\.\d{1,3})?$' then
      raise exception 'quantity_must_have_at_most_three_decimals';
    end if;
    v_quantity := v_quantity_text::numeric;
    if v_quantity <= 0 then
      raise exception 'quantity_must_be_positive';
    end if;
    if v_quantity * 1000 > 9007199254740991::numeric then
      raise exception 'quantity_too_large';
    end if;
    v_quantity_milli := (v_quantity * 1000)::bigint;

    v_unit_price_text := v_input_line->>'unit_price_minor';
    if v_unit_price_text is null or v_unit_price_text !~ '^\d+$' then
      raise exception 'unit_price_must_be_nonnegative_integer';
    end if;
    if v_unit_price_text::numeric > 9007199254740991::numeric then
      raise exception 'unit_price_too_large';
    end if;
    v_unit_price := v_unit_price_text::bigint;

    v_description := trim(coalesce(v_input_line->>'description', ''));
    v_category := null;
    v_unit := nullif(trim(coalesce(v_input_line->>'unit', '')), '');

    -- Lock the request while validating it so its product/quantity/status
    -- cannot change between validation and document creation.
    if v_request_id is not null then
      select pr.restaurant_id, pr.product_id, pr.quantity, pr.status
      into v_request
      from public.purchase_requests pr
      where pr.id = v_request_id
      for update;

      if v_request.restaurant_id is null or v_request.restaurant_id <> p_restaurant_id then
        raise exception 'request_not_owned_by_tenant';
      end if;
      if v_request.status <> 'pending' then
        raise exception 'request_not_pending';
      end if;
      if v_product_id is not null and v_product_id <> v_request.product_id then
        raise exception 'request_product_mismatch';
      end if;
      v_product_id := v_request.product_id;
      if v_quantity <> v_request.quantity then
        raise exception 'request_quantity_mismatch';
      end if;
    end if;

    if v_product_id is not null then
      select p.restaurant_id, p.name, p.unit, c.name as category_name
      into v_product
      from public.products p
      left join public.categories c
        on c.id = p.category_id and c.restaurant_id = p.restaurant_id
      where p.id = v_product_id;

      if v_product.restaurant_id is null or v_product.restaurant_id <> p_restaurant_id then
        raise exception 'product_not_owned_by_tenant';
      end if;

      -- Product metadata is authoritative for tax classification.
      v_description := v_product.name;
      v_category := v_product.category_name;
      v_unit := v_product.unit;
    elsif v_description = '' then
      raise exception 'description_required';
    end if;

    select rule.value
    into v_vat_rule
    from jsonb_array_elements(v_rule_set.rules) as rule(value)
    where rule.value->>'kind' = 'vat'
      and rule.value->>'applies_to' = 'categories'
      and v_category is not null
      and exists (
        select 1
        from jsonb_array_elements_text(coalesce(rule.value->'categories', '[]'::jsonb)) as category(value)
        where category.value = v_category
      )
    limit 1;

    if v_vat_rule is null then
      select rule.value
      into v_vat_rule
      from jsonb_array_elements(v_rule_set.rules) as rule(value)
      where rule.value->>'kind' = 'vat'
        and rule.value->>'applies_to' = 'default'
      limit 1;
    end if;

    if v_vat_rule is null then
      v_vat_rate := 0;
      v_vat_name := 'No VAT rule';
    else
      if coalesce(v_vat_rule->>'rate_bps', '') !~ '^\d+$'
         or (v_vat_rule->>'rate_bps')::numeric > 100000 then
        raise exception 'invalid_vat_rule';
      end if;
      v_vat_rate := (v_vat_rule->>'rate_bps')::bigint;
      v_vat_name := coalesce(nullif(v_vat_rule->>'name', ''), 'VAT');
    end if;

    v_line_subtotal := public.round_nonnegative_ratio(
      v_quantity_milli::numeric * v_unit_price::numeric,
      1000,
      v_rule_set.rounding_mode
    );
    v_tax_minor := public.round_nonnegative_ratio(
      v_line_subtotal::numeric * v_vat_rate::numeric,
      10000,
      v_rule_set.rounding_mode
    );
    v_line_total := v_line_subtotal + v_tax_minor;

    v_normalized_input := v_normalized_input || jsonb_build_array(jsonb_build_object(
      'request_id', v_request_id,
      'product_id', v_product_id,
      'description', v_description,
      'category_name', v_category,
      'quantity', v_quantity,
      'unit', v_unit,
      'unit_price_minor', v_unit_price
    ));

    v_calculated_lines := v_calculated_lines || jsonb_build_array(jsonb_build_object(
      'request_id', v_request_id,
      'product_id', v_product_id,
      'description', v_description,
      'category_name', v_category,
      'quantity', v_quantity,
      'quantity_milli', v_quantity_milli,
      'unit', v_unit,
      'unit_price_minor', v_unit_price,
      'line_subtotal_minor', v_line_subtotal,
      'tax_minor', v_tax_minor,
      'line_total_minor', v_line_total,
      'tax_detail', jsonb_build_object('rule_name', v_vat_name, 'rate_bps', v_vat_rate)
    ));

    v_trace := v_trace || jsonb_build_array(jsonb_build_object(
      'step', 'line_priced',
      'detail', jsonb_build_object(
        'description', v_description,
        'category', v_category,
        'quantity_milli', v_quantity_milli,
        'unit_price_minor', v_unit_price,
        'line_subtotal_minor', v_line_subtotal,
        'matched_rule', jsonb_build_object('name', v_vat_name, 'rate_bps', v_vat_rate),
        'tax_minor', v_tax_minor
      )
    ));

    v_subtotal := v_subtotal + v_line_subtotal;
    v_tax_total := v_tax_total + v_tax_minor;

  end loop;

  select rule.value
  into v_withholding_rule
  from jsonb_array_elements(v_rule_set.rules) as rule(value)
  where rule.value->>'kind' = 'withholding'
  limit 1;

  if v_withholding_rule is not null then
    if coalesce(v_withholding_rule->>'rate_bps', '') !~ '^\d+$'
       or coalesce(v_withholding_rule->>'threshold_minor', '') !~ '^\d+$'
       or (v_withholding_rule->>'rate_bps')::numeric > 100000
       or (v_withholding_rule->>'threshold_minor')::numeric > 9007199254740991::numeric then
      raise exception 'invalid_withholding_rule';
    end if;

    v_withholding_rate := (v_withholding_rule->>'rate_bps')::bigint;
    v_withholding_limit := (v_withholding_rule->>'threshold_minor')::bigint;
    if v_subtotal >= v_withholding_limit then
      v_withholding := public.round_nonnegative_ratio(
        v_subtotal::numeric * v_withholding_rate::numeric,
        10000,
        v_rule_set.rounding_mode
      );
      v_trace := v_trace || jsonb_build_array(jsonb_build_object(
        'step', 'withholding_applied',
        'detail', jsonb_build_object(
          'rule', v_withholding_rule->>'name',
          'rate_bps', v_withholding_rate,
          'threshold_minor', v_withholding_limit,
          'base_minor', v_subtotal,
          'withholding_minor', v_withholding
        )
      ));
    else
      v_trace := v_trace || jsonb_build_array(jsonb_build_object(
        'step', 'withholding_below_threshold',
        'detail', jsonb_build_object(
          'rule', v_withholding_rule->>'name',
          'threshold_minor', v_withholding_limit,
          'base_minor', v_subtotal
        )
      ));
    end if;
  end if;

  v_total := v_subtotal + v_tax_total - v_withholding;
  if v_total < 0 then
    raise exception 'calculated_total_negative';
  end if;

  v_trace := v_trace || jsonb_build_array(jsonb_build_object(
    'step', 'totals',
    'detail', jsonb_build_object(
      'subtotal_minor', v_subtotal,
      'tax_total_minor', v_tax_total,
      'withholding_minor', v_withholding,
      'total_minor', v_total
    )
  ));

  return jsonb_build_object(
    'input', jsonb_build_object('on_date', current_date, 'lines', v_normalized_input),
    'lines', v_calculated_lines,
    'subtotal_minor', v_subtotal,
    'tax_total_minor', v_tax_total,
    'withholding_minor', v_withholding,
    'total_minor', v_total,
    'rule_set', jsonb_build_object(
      'id', v_rule_set.id,
      'version', v_rule_set.version,
      'name', v_rule_set.name,
      'rounding_mode', v_rule_set.rounding_mode
    ),
    'trace', v_trace
  );
end;
$$;

-- Same public signature as migration 018 so the UI remains compatible. The
-- legacy p_lines/p_calc_output/totals are now assertions only; persisted
-- lines/output/trace come exclusively from the server recomputation above.
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
  v_authoritative  jsonb;
  v_calc_id        uuid;
  v_po_id          uuid;
  v_po_number      text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select rm.restaurant_id into v_restaurant_id
  from public.restaurant_members rm
  where rm.user_id = v_uid
    and rm.role = 'manager'
  limit 1;

  if v_restaurant_id is null then
    raise exception 'manager_required';
  end if;
  if not public.has_entitlement(v_restaurant_id, 'billing_pro') then
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
    v_restaurant_id,
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
      v_restaurant_id,
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

  v_po_number := public.next_po_number(v_restaurant_id);

  insert into public.purchase_orders
    (restaurant_id, po_number, supplier_name, currency,
     subtotal_minor, tax_total_minor, withholding_minor, total_minor,
     tax_calculation_id, created_by)
  values
    (
      v_restaurant_id,
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
    v_restaurant_id,
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
    v_restaurant_id, v_uid, 'user',
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

-- Serialises cancel against approve and performs a compare-and-set update.
-- Without the row lock, a cancel that observed "draft" could wait behind an
-- approval and then overwrite the newly approved state.
create or replace function public.cancel_purchase_order(p_po_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_po  record;
  v_updated int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select po.id, po.restaurant_id, po.po_number, po.status
  into v_po
  from public.purchase_orders po
  where po.id = p_po_id
  for update;

  if v_po.id is null or not public.is_manager(v_po.restaurant_id) then
    raise exception 'manager_required';
  end if;
  if v_po.status <> 'draft' then
    raise exception 'only_drafts_can_be_cancelled';
  end if;

  update public.purchase_orders po
  set status = 'cancelled', updated_at = now()
  where po.id = p_po_id and po.status = 'draft';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'po_state_changed';
  end if;

  perform public.log_audit(
    v_po.restaurant_id, v_uid, 'user',
    'po.cancelled', 'purchase_order', p_po_id,
    jsonb_build_object('po_number', v_po.po_number)
  );
end;
$$;

-- ============================================================================
-- OTP issuance. Rate-limit decision + challenge INSERT happen in one database
-- transaction. Transaction-scoped advisory locks serialise the normalized
-- phone and IP buckets, so concurrent resend requests cannot all observe an
-- empty window before any challenge exists.

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
  v_phone        text := trim(p_phone);
  v_ip           text := nullif(lower(trim(coalesce(p_ip, ''))), '');
  v_last_at      timestamptz;
  v_phone_hour   int;
  v_ip_hour      int;
  v_challenge_id uuid;
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
  if p_provider is null or length(trim(p_provider)) = 0 then
    raise exception 'provider_required';
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

  -- Stable namespaces avoid phone/IP key overlap. Every caller takes locks in
  -- phone-then-IP order, avoiding a lock-order cycle.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('otp-phone:' || v_phone, 0)
  );
  if v_ip is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('otp-ip:' || v_ip, 0)
    );
  end if;

  select max(c.created_at), count(*) filter (where c.created_at > now() - interval '1 hour')
  into v_last_at, v_phone_hour
  from public.otp_challenges c
  where c.phone = v_phone;

  if v_last_at is not null and v_last_at > now() - interval '60 seconds' then
    return query select
      'cooldown'::text,
      null::uuid,
      greatest(
        1,
        ceil(extract(epoch from (v_last_at + interval '60 seconds' - now())))::int
      );
    return;
  end if;

  if v_phone_hour >= 5 then
    return query select 'phone_hourly_limit'::text, null::uuid, null::int;
    return;
  end if;

  if v_ip is not null then
    select count(*) into v_ip_hour
    from public.otp_challenges c
    where c.created_ip = v_ip
      and c.created_at > now() - interval '1 hour';

    if v_ip_hour >= 10 then
      return query select 'ip_hourly_limit'::text, null::uuid, null::int;
      return;
    end if;
  end if;

  insert into public.otp_challenges
    (restaurant_id, user_id, phone, channel, purpose, reference_id,
     code_hash, salt, expires_at, created_ip, provider)
  values
    (p_restaurant_id, p_user_id, v_phone, p_channel, p_purpose, p_reference_id,
     p_code_hash, p_salt, p_expires_at, v_ip, trim(p_provider))
  returning id into v_challenge_id;

  return query select 'issued'::text, v_challenge_id, null::int;
end;
$$;

-- OTP attempt claiming. The row lock serialises concurrent callers and the
-- increment happens inside the same transaction that returns the hash/salt.

create or replace function public.claim_otp_attempt(
  p_challenge_id uuid,
  p_user_id uuid
) returns table (
  outcome text,
  code_hash text,
  salt text,
  attempts_remaining int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge public.otp_challenges%rowtype;
begin
  select c.* into v_challenge
  from public.otp_challenges c
  where c.id = p_challenge_id
    and c.user_id = p_user_id
  for update;

  if not found then
    return query select 'not_found'::text, null::text, null::text, null::int;
    return;
  end if;
  if v_challenge.consumed_at is not null then
    return query select 'consumed'::text, null::text, null::text, 0;
    return;
  end if;
  if v_challenge.verified_at is not null then
    return query select 'already_verified'::text, null::text, null::text,
      greatest(0, v_challenge.max_attempts - v_challenge.attempts);
    return;
  end if;
  if v_challenge.expires_at <= now() then
    return query select 'expired'::text, null::text, null::text, 0;
    return;
  end if;
  if v_challenge.attempts >= v_challenge.max_attempts then
    return query select 'max_attempts'::text, null::text, null::text, 0;
    return;
  end if;

  update public.otp_challenges c
  set attempts = c.attempts + 1
  where c.id = v_challenge.id;

  return query select
    'ready'::text,
    v_challenge.code_hash,
    v_challenge.salt,
    greatest(0, v_challenge.max_attempts - v_challenge.attempts - 1);
end;
$$;

create or replace function public.mark_otp_verified(
  p_challenge_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update public.otp_challenges c
  set verified_at = now()
  where c.id = p_challenge_id
    and c.user_id = p_user_id
    and c.verified_at is null
    and c.consumed_at is null
    and c.expires_at > now()
    and c.attempts > 0
    and c.attempts <= c.max_attempts;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return true;
  end if;

  return exists (
    select 1 from public.otp_challenges c
    where c.id = p_challenge_id
      and c.user_id = p_user_id
      and c.verified_at is not null
      and c.consumed_at is null
      and c.expires_at > now()
  );
end;
$$;

-- Lock both the PO and challenge. A concurrent approval waits, then observes
-- the already-approved PO; the verified challenge can be consumed once only.
create or replace function public.approve_purchase_order(p_po_id uuid, p_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_po        record;
  v_challenge record;
  v_approver  text;
  v_consumed  int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select po.id, po.restaurant_id, po.po_number, po.supplier_name,
         po.status, po.total_minor, po.currency
  into v_po
  from public.purchase_orders po
  where po.id = p_po_id
  for update;

  if v_po.id is null or not public.is_manager(v_po.restaurant_id) then
    raise exception 'manager_required';
  end if;
  if not public.has_entitlement(v_po.restaurant_id, 'billing_pro') then
    raise exception 'entitlement_required';
  end if;
  if v_po.status <> 'draft' then
    raise exception 'only_drafts_can_be_approved';
  end if;

  select c.id, c.restaurant_id, c.user_id, c.purpose, c.reference_id,
         c.verified_at, c.consumed_at, c.expires_at
  into v_challenge
  from public.otp_challenges c
  where c.id = p_challenge_id
  for update;

  if v_challenge.id is null
     or v_challenge.restaurant_id <> v_po.restaurant_id
     or v_challenge.user_id <> v_uid
     or v_challenge.purpose <> 'approve_po'
     or v_challenge.reference_id <> p_po_id
     or v_challenge.verified_at is null
     or v_challenge.consumed_at is not null
     or v_challenge.expires_at <= now()
     or v_challenge.verified_at <= now() - interval '10 minutes' then
    raise exception 'otp_verification_required';
  end if;

  update public.otp_challenges c
  set consumed_at = now()
  where c.id = p_challenge_id
    and c.consumed_at is null;
  get diagnostics v_consumed = row_count;
  if v_consumed <> 1 then
    raise exception 'otp_challenge_already_consumed';
  end if;

  update public.purchase_orders po
  set status = 'approved', approved_by = v_uid, approved_at = now(), updated_at = now()
  where po.id = p_po_id and po.status = 'draft';

  select coalesce(p.full_name, p.email, 'Unknown') into v_approver
  from public.profiles p where p.id = v_uid;

  perform public.log_audit(
    v_po.restaurant_id, v_uid, 'user',
    'po.approved', 'purchase_order', p_po_id,
    jsonb_build_object(
      'po_number', v_po.po_number,
      'supplier', v_po.supplier_name,
      'total_minor', v_po.total_minor,
      'currency', v_po.currency,
      'otp_challenge_id', p_challenge_id
    )
  );

  perform public.emit_outbox_event(
    v_po.restaurant_id, 'po.approved',
    jsonb_build_object(
      'poNumber', v_po.po_number,
      'supplier', v_po.supplier_name,
      'totalMinor', v_po.total_minor,
      'currency', v_po.currency,
      'approvedBy', v_approver
    )
  );
end;
$$;

-- ============================================================================
-- RLS helpers and trigger functions: safe search paths + explicit ACLs.

create or replace function public.is_member(restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurant_members rm
    where rm.restaurant_id = $1
      and rm.user_id = auth.uid()
  );
$$;

create or replace function public.is_manager(restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurant_members rm
    where rm.restaurant_id = $1
      and rm.user_id = auth.uid()
      and rm.role = 'manager'
  );
$$;

create or replace function public.shares_restaurant_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_members me
    join public.restaurant_members them on them.restaurant_id = me.restaurant_id
    where me.user_id = auth.uid()
      and them.user_id = p_user_id
  );
$$;

create or replace function public.set_po_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Remove PostgreSQL's default PUBLIC EXECUTE from every internal/definer
-- function touched here, then grant only the role that actually calls it.
revoke execute on function public.round_nonnegative_ratio(numeric, bigint, text) from public, anon, authenticated, service_role;
revoke execute on function public.calculate_purchase_order_authoritative(uuid, uuid, int, jsonb) from public, anon, authenticated, service_role;

revoke execute on function public.create_purchase_order(text, text, uuid, int, jsonb, jsonb, jsonb, jsonb, bigint, bigint, bigint, bigint) from public, anon, service_role;
grant execute on function public.create_purchase_order(text, text, uuid, int, jsonb, jsonb, jsonb, jsonb, bigint, bigint, bigint, bigint) to authenticated;

revoke execute on function public.cancel_purchase_order(uuid) from public, anon, service_role;
grant execute on function public.cancel_purchase_order(uuid) to authenticated;

revoke execute on function public.claim_otp_attempt(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.mark_otp_verified(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.issue_otp_challenge(uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.claim_otp_attempt(uuid, uuid) to service_role;
grant execute on function public.mark_otp_verified(uuid, uuid) to service_role;
grant execute on function public.issue_otp_challenge(uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text) to service_role;

revoke execute on function public.approve_purchase_order(uuid, uuid) from public, anon, service_role;
grant execute on function public.approve_purchase_order(uuid, uuid) to authenticated;

revoke execute on function public.has_entitlement(uuid, text) from public, anon, authenticated;
grant execute on function public.has_entitlement(uuid, text) to service_role;

revoke execute on function public.is_member(uuid) from public, anon, service_role;
revoke execute on function public.is_manager(uuid) from public, anon, service_role;
revoke execute on function public.shares_restaurant_with(uuid) from public, anon, service_role;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_manager(uuid) to authenticated;
grant execute on function public.shares_restaurant_with(uuid) to authenticated;

revoke execute on function public.notify_urgent_request() from public, anon, authenticated, service_role;
revoke execute on function public.sync_entitlement_from_subscription() from public, anon, authenticated, service_role;
revoke execute on function public.seed_default_categories(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.set_po_updated_at() from public, anon, authenticated, service_role;

-- Reinforce the ledgers' intended writer. These grants are intentionally
-- duplicated from 022 so the final ACL state is evident in this correction.
revoke execute on function public.log_audit(uuid, uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.emit_outbox_event(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.log_audit(uuid, uuid, text, text, text, uuid, jsonb) to service_role;
grant execute on function public.emit_outbox_event(uuid, text, jsonb) to service_role;
