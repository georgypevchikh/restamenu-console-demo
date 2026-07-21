-- Recoverable Xero writes: supplier ContactID mappings plus fenced PO pushes.
--
-- Xero's Idempotency-Key cache is deliberately short-lived (six minutes).
-- These tables therefore do NOT treat one permanent key as a durable dedupe
-- boundary. Each network POST has an attempt key + timestamp. Before any new
-- POST, xero-sync queries Xero by an exact deterministic identity:
--   contact: exact normalized supplier Name
--   invoice: RM:<restaurant uuid>:<local PO number> in Reference
-- A still-live ambiguous attempt may reuse its key; after the safe window a
-- fresh key is generated only after reconciliation found no external object.
-- Local claim_token values fence expired workers from mutating a newer lease.

create table public.xero_contact_mappings (
  restaurant_id       uuid not null references public.restaurants (id) on delete cascade,
  supplier_key        text not null,
  supplier_name       text not null,
  external_contact_number text not null unique,
  xero_contact_id     text,
  state               text not null default 'retryable'
                        check (state in ('resolving', 'retryable', 'resolved')),
  claim_token         uuid,
  lease_until         timestamptz,
  current_attempt_key text,
  attempt_started_at  timestamptz,
  attempt_count       int not null default 0 check (attempt_count >= 0),
  needs_reconciliation boolean not null default false,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (restaurant_id, supplier_key),
  check (char_length(supplier_key) between 1 and 200),
  check (char_length(supplier_name) between 1 and 200),
  check (external_contact_number ~ '^RM:[0-9a-f]{24}$'),
  check (current_attempt_key is null or char_length(current_attempt_key) <= 128)
);

create unique index xero_contact_mappings_contact_idx
  on public.xero_contact_mappings (restaurant_id, xero_contact_id)
  where xero_contact_id is not null;
create index xero_contact_mappings_state_lease_idx
  on public.xero_contact_mappings (state, lease_until);

create table public.xero_invoice_pushes (
  purchase_order_id    uuid primary key references public.purchase_orders (id) on delete cascade,
  restaurant_id        uuid not null references public.restaurants (id) on delete cascade,
  external_reference   text not null unique,
  state                text not null default 'retryable'
                         check (state in ('in_progress', 'retryable', 'succeeded')),
  claim_token          uuid,
  lease_until          timestamptz,
  current_attempt_key  text,
  attempt_started_at   timestamptz,
  attempt_count        int not null default 0 check (attempt_count >= 0),
  needs_reconciliation boolean not null default false,
  xero_invoice_id      text,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (char_length(external_reference) between 1 and 255),
  check (current_attempt_key is null or char_length(current_attempt_key) <= 128)
);

create index xero_invoice_pushes_state_lease_idx
  on public.xero_invoice_pushes (state, lease_until);
create unique index xero_invoice_pushes_restaurant_invoice_idx
  on public.xero_invoice_pushes (restaurant_id, xero_invoice_id)
  where xero_invoice_id is not null;

alter table public.xero_contact_mappings enable row level security;
alter table public.xero_invoice_pushes enable row level security;
-- No policies: only service-role RPCs inspect or mutate these coordination rows.

-- A complete paginated import is a snapshot. Track which local mirror rows
-- were present in that snapshot so an invoice removed from the Xero query is
-- visibly stale instead of remaining indistinguishable from current data.
alter table public.xero_bills
  add column last_seen_at timestamptz not null default now(),
  add column is_stale boolean not null default false,
  add column stale_at timestamptz;

create index xero_bills_restaurant_stale_idx
  on public.xero_bills (restaurant_id, is_stale, last_seen_at desc);

-- ------------------------------------------------------ contact resolution

create or replace function public.claim_xero_contact_resolution(
  p_restaurant_id uuid,
  p_supplier_key  text,
  p_supplier_name text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mapping public.xero_contact_mappings%rowtype;
  v_claim_token uuid := extensions.gen_random_uuid();
  v_contact_number text := 'RM:' || substr(
    encode(extensions.digest(p_restaurant_id::text || ':' || p_supplier_key, 'sha256'), 'hex'),
    1,
    24
  );
begin
  if p_supplier_key is null or char_length(p_supplier_key) not between 1 and 200
     or p_supplier_name is null or char_length(btrim(p_supplier_name)) not between 1 and 200 then
    raise exception 'invalid_supplier_identity';
  end if;
  if not exists (
    select 1 from public.xero_connections xc
    where xc.restaurant_id = p_restaurant_id and xc.status = 'connected'
  ) then
    raise exception 'xero_connection_not_found';
  end if;

  insert into public.xero_contact_mappings
    (restaurant_id, supplier_key, supplier_name, external_contact_number)
  values
    (p_restaurant_id, p_supplier_key, btrim(p_supplier_name), v_contact_number)
  on conflict (restaurant_id, supplier_key) do nothing;

  select * into v_mapping
  from public.xero_contact_mappings
  where restaurant_id = p_restaurant_id and supplier_key = p_supplier_key
  for update;

  if v_mapping.external_contact_number <> v_contact_number then
    raise exception 'xero_contact_identity_mismatch';
  end if;

  if v_mapping.state = 'resolved' and v_mapping.xero_contact_id is not null then
    return jsonb_build_object(
      'state', 'resolved',
      'xero_contact_id', v_mapping.xero_contact_id,
      'external_contact_number', v_contact_number
    );
  end if;
  if v_mapping.state = 'resolving' and v_mapping.lease_until > now() then
    return jsonb_build_object(
      'state', 'busy',
      'external_contact_number', v_contact_number,
      'retry_after_seconds', greatest(
        1, ceil(extract(epoch from (v_mapping.lease_until - now())))::int
      )
    );
  end if;

  update public.xero_contact_mappings
  set state = 'resolving',
      supplier_name = btrim(p_supplier_name),
      claim_token = v_claim_token,
      lease_until = now() + interval '5 minutes',
      last_error = null,
      updated_at = now()
  where restaurant_id = p_restaurant_id and supplier_key = p_supplier_key;

  return jsonb_build_object(
    'state', 'claimed',
    'claim_token', v_claim_token,
    'external_contact_number', v_contact_number,
    'needs_reconciliation', v_mapping.needs_reconciliation
  );
end;
$$;

create or replace function public.begin_xero_contact_post_attempt(
  p_restaurant_id uuid,
  p_supplier_key  text,
  p_claim_token   uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mapping public.xero_contact_mappings%rowtype;
  v_key text;
  v_started timestamptz;
  v_reused boolean := false;
begin
  select * into v_mapping
  from public.xero_contact_mappings
  where restaurant_id = p_restaurant_id
    and supplier_key = p_supplier_key
    and claim_token = p_claim_token
    and state = 'resolving'
  for update;
  if not found then raise exception 'xero_contact_stale_claim'; end if;

  -- Keep 30 seconds of safety margin inside Xero's documented six minutes.
  if v_mapping.needs_reconciliation
     and v_mapping.current_attempt_key is not null
     and v_mapping.attempt_started_at > now() - interval '5 minutes 30 seconds' then
    v_key := v_mapping.current_attempt_key;
    v_started := v_mapping.attempt_started_at;
    v_reused := true;
  else
    v_key := 'restamenu:contact:' || replace(extensions.gen_random_uuid()::text, '-', '');
    v_started := now();
    update public.xero_contact_mappings
    set current_attempt_key = v_key,
        attempt_started_at = v_started,
        attempt_count = attempt_count + 1
    where restaurant_id = p_restaurant_id and supplier_key = p_supplier_key;
  end if;

  -- Set before crossing the network boundary; a process crash is ambiguous.
  update public.xero_contact_mappings
  set needs_reconciliation = true, updated_at = now()
  where restaurant_id = p_restaurant_id and supplier_key = p_supplier_key;

  return jsonb_build_object(
    'idempotency_key', v_key,
    'reused', v_reused,
    'valid_until', v_started + interval '6 minutes'
  );
end;
$$;

create or replace function public.release_xero_contact_resolution(
  p_restaurant_id uuid,
  p_supplier_key  text,
  p_claim_token   uuid,
  p_error         text,
  p_ambiguous     boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.xero_contact_mappings
  set state = 'retryable',
      claim_token = null,
      lease_until = null,
      needs_reconciliation = p_ambiguous,
      last_error = left(coalesce(p_error, 'unknown error'), 1000),
      updated_at = now()
  where restaurant_id = p_restaurant_id
    and supplier_key = p_supplier_key
    and claim_token = p_claim_token
    and state = 'resolving';
  return found;
end;
$$;

create or replace function public.complete_xero_contact_resolution(
  p_restaurant_id  uuid,
  p_supplier_key   text,
  p_claim_token    uuid,
  p_xero_contact_id text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_xero_contact_id is null
     or p_xero_contact_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_xero_contact_id';
  end if;
  update public.xero_contact_mappings
  set state = 'resolved',
      xero_contact_id = lower(p_xero_contact_id),
      claim_token = null,
      lease_until = null,
      needs_reconciliation = false,
      last_error = null,
      updated_at = now()
  where restaurant_id = p_restaurant_id
    and supplier_key = p_supplier_key
    and claim_token = p_claim_token
    and state = 'resolving';
  if not found then raise exception 'xero_contact_stale_claim'; end if;
  return true;
end;
$$;

-- ---------------------------------------------------------- invoice pushes

create or replace function public.claim_xero_invoice_push(
  p_restaurant_id uuid,
  p_po_id         uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po record;
  v_push public.xero_invoice_pushes%rowtype;
  v_reference text;
  v_claim_token uuid := extensions.gen_random_uuid();
begin
  select po.restaurant_id, po.po_number, po.status, po.xero_invoice_id
  into v_po
  from public.purchase_orders po
  where po.id = p_po_id
  for update;

  if not found or v_po.restaurant_id <> p_restaurant_id then
    raise exception 'xero_push_po_not_found';
  end if;
  if v_po.status <> 'approved' then raise exception 'xero_push_po_not_approved'; end if;
  v_reference := 'RM:' || p_restaurant_id::text || ':' || v_po.po_number;
  if v_reference !~ '^[A-Za-z0-9:._-]{1,255}$' then
    raise exception 'invalid_xero_reference';
  end if;

  insert into public.xero_invoice_pushes
    (purchase_order_id, restaurant_id, external_reference)
  values (p_po_id, p_restaurant_id, v_reference)
  on conflict (purchase_order_id) do nothing;

  select * into v_push
  from public.xero_invoice_pushes
  where purchase_order_id = p_po_id
  for update;
  if v_push.restaurant_id <> p_restaurant_id
     or v_push.external_reference <> v_reference then
    raise exception 'xero_push_claim_mismatch';
  end if;

  if v_po.xero_invoice_id is not null then
    update public.xero_invoice_pushes
    set state = 'succeeded', xero_invoice_id = v_po.xero_invoice_id,
        claim_token = null, lease_until = null,
        needs_reconciliation = false, last_error = null, updated_at = now()
    where purchase_order_id = p_po_id;
    return jsonb_build_object(
      'state', 'succeeded',
      'external_reference', v_reference,
      'xero_invoice_id', v_po.xero_invoice_id
    );
  end if;
  if v_push.state = 'succeeded' and v_push.xero_invoice_id is not null then
    update public.purchase_orders
    set xero_invoice_id = v_push.xero_invoice_id, updated_at = now()
    where id = p_po_id and xero_invoice_id is null;
    return jsonb_build_object(
      'state', 'succeeded',
      'external_reference', v_reference,
      'xero_invoice_id', v_push.xero_invoice_id
    );
  end if;
  if v_push.state = 'in_progress' and v_push.lease_until > now() then
    return jsonb_build_object(
      'state', 'busy',
      'external_reference', v_reference,
      'retry_after_seconds', greatest(
        1, ceil(extract(epoch from (v_push.lease_until - now())))::int
      )
    );
  end if;

  update public.xero_invoice_pushes
  set state = 'in_progress', claim_token = v_claim_token,
      lease_until = now() + interval '5 minutes', last_error = null,
      updated_at = now()
  where purchase_order_id = p_po_id;

  return jsonb_build_object(
    'state', 'claimed',
    'claim_token', v_claim_token,
    'external_reference', v_reference,
    'needs_reconciliation', v_push.needs_reconciliation
  );
end;
$$;

create or replace function public.begin_xero_invoice_post_attempt(
  p_restaurant_id uuid,
  p_po_id         uuid,
  p_claim_token   uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_push public.xero_invoice_pushes%rowtype;
  v_key text;
  v_started timestamptz;
  v_reused boolean := false;
begin
  select * into v_push
  from public.xero_invoice_pushes
  where purchase_order_id = p_po_id
    and restaurant_id = p_restaurant_id
    and claim_token = p_claim_token
    and state = 'in_progress'
  for update;
  if not found then raise exception 'xero_push_stale_claim'; end if;

  if v_push.needs_reconciliation
     and v_push.current_attempt_key is not null
     and v_push.attempt_started_at > now() - interval '5 minutes 30 seconds' then
    v_key := v_push.current_attempt_key;
    v_started := v_push.attempt_started_at;
    v_reused := true;
  else
    v_key := 'restamenu:invoice:' || replace(extensions.gen_random_uuid()::text, '-', '');
    v_started := now();
    update public.xero_invoice_pushes
    set current_attempt_key = v_key,
        attempt_started_at = v_started,
        attempt_count = attempt_count + 1
    where purchase_order_id = p_po_id;
  end if;

  update public.xero_invoice_pushes
  set needs_reconciliation = true, updated_at = now()
  where purchase_order_id = p_po_id;

  return jsonb_build_object(
    'idempotency_key', v_key,
    'reused', v_reused,
    'valid_until', v_started + interval '6 minutes'
  );
end;
$$;

create or replace function public.release_xero_invoice_push(
  p_restaurant_id uuid,
  p_po_id         uuid,
  p_claim_token   uuid,
  p_error         text,
  p_ambiguous     boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.xero_invoice_pushes
  set state = 'retryable', claim_token = null, lease_until = null,
      needs_reconciliation = p_ambiguous,
      last_error = left(coalesce(p_error, 'unknown error'), 1000),
      updated_at = now()
  where purchase_order_id = p_po_id
    and restaurant_id = p_restaurant_id
    and claim_token = p_claim_token
    and state = 'in_progress';
  return found;
end;
$$;

create or replace function public.complete_xero_invoice_push(
  p_restaurant_id   uuid,
  p_po_id           uuid,
  p_claim_token     uuid,
  p_xero_invoice_id text,
  p_actor_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po record;
  v_push public.xero_invoice_pushes%rowtype;
begin
  if p_xero_invoice_id is null
     or p_xero_invoice_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_xero_invoice_id';
  end if;
  select po.po_number, po.total_minor, po.xero_invoice_id
  into v_po
  from public.purchase_orders po
  where po.id = p_po_id and po.restaurant_id = p_restaurant_id
  for update;
  if not found then raise exception 'xero_push_po_not_found'; end if;

  select * into v_push
  from public.xero_invoice_pushes
  where purchase_order_id = p_po_id
    and restaurant_id = p_restaurant_id
    and claim_token = p_claim_token
    and state = 'in_progress'
  for update;
  if not found then raise exception 'xero_push_stale_claim'; end if;

  if v_po.xero_invoice_id is not null then
    if lower(v_po.xero_invoice_id) <> lower(p_xero_invoice_id) then
      raise exception 'xero_invoice_id_conflict';
    end if;
    update public.xero_invoice_pushes
    set state = 'succeeded', xero_invoice_id = lower(p_xero_invoice_id),
        claim_token = null, lease_until = null,
        needs_reconciliation = false, last_error = null, updated_at = now()
    where purchase_order_id = p_po_id;
    return jsonb_build_object(
      'completed', false,
      'already_completed', true,
      'xero_invoice_id', lower(p_xero_invoice_id)
    );
  end if;

  update public.purchase_orders
  set xero_invoice_id = lower(p_xero_invoice_id), updated_at = now()
  where id = p_po_id;
  update public.xero_invoice_pushes
  set state = 'succeeded', xero_invoice_id = lower(p_xero_invoice_id),
      claim_token = null, lease_until = null,
      needs_reconciliation = false, last_error = null, updated_at = now()
  where purchase_order_id = p_po_id;

  insert into public.xero_sync_log
    (restaurant_id, operation, direction, status, xero_id, summary)
  values
    (p_restaurant_id, 'invoice_push', 'push', 'success', lower(p_xero_invoice_id),
     jsonb_build_object(
       'po_number', v_po.po_number,
       'total_minor', v_po.total_minor,
       'external_reference', v_push.external_reference
     ));
  perform public.log_audit(
    p_restaurant_id, p_actor_id, 'xero',
    'xero.invoice_pushed', 'purchase_order', p_po_id,
    jsonb_build_object(
      'po_number', v_po.po_number,
      'xero_invoice_id', lower(p_xero_invoice_id),
      'external_reference', v_push.external_reference
    )
  );
  perform public.emit_outbox_event(
    p_restaurant_id, 'xero.invoice_pushed',
    jsonb_build_object(
      'poNumber', v_po.po_number,
      'xeroInvoiceId', lower(p_xero_invoice_id)
    )
  );
  return jsonb_build_object(
    'completed', true,
    'already_completed', false,
    'xero_invoice_id', lower(p_xero_invoice_id)
  );
end;
$$;

-- Reauthorising the same organisation rotates credentials. Silently binding
-- a restaurant to a different Xero tenant would make every persisted
-- ContactID and InvoiceID point at the wrong accounting namespace, so the
-- atomic upsert refuses that transition (including two racing callbacks).
create or replace function public.store_xero_tokens(
  p_restaurant_id uuid,
  p_access        text,
  p_refresh       text,
  p_expires_at    timestamptz,
  p_tenant_id     text,
  p_tenant_name   text,
  p_scopes        text,
  p_connected_by  uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := public.xero_vault_key();
  v_applied int := 0;
begin
  if p_tenant_id is null
     or p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_xero_tenant_id';
  end if;

  insert into public.xero_connections as xc
    (restaurant_id, xero_tenant_id, xero_tenant_name,
     access_token_enc, refresh_token_enc, access_expires_at,
     scopes, status, connected_by, updated_at)
  values
    (p_restaurant_id, lower(p_tenant_id), p_tenant_name,
     extensions.pgp_sym_encrypt(p_access, v_key),
     extensions.pgp_sym_encrypt(p_refresh, v_key),
     p_expires_at, p_scopes, 'connected', p_connected_by, now())
  on conflict (restaurant_id) do update
    set xero_tenant_id    = excluded.xero_tenant_id,
        xero_tenant_name  = excluded.xero_tenant_name,
        access_token_enc  = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        access_expires_at = excluded.access_expires_at,
        scopes            = excluded.scopes,
        status            = 'connected',
        connected_by      = excluded.connected_by,
        updated_at        = now()
  where xc.xero_tenant_id is null
     or lower(xc.xero_tenant_id) = lower(excluded.xero_tenant_id);
  get diagnostics v_applied = row_count;

  if v_applied <> 1 then
    raise exception 'xero_tenant_change_requires_explicit_reset';
  end if;

  perform public.log_audit(
    p_restaurant_id, p_connected_by, 'xero',
    'xero.connected', 'xero_connection', null,
    jsonb_build_object('tenant_name', p_tenant_name)
  );
end;
$$;

-- A refresh failure may belong to a stale worker whose token was already
-- rotated by a concurrent winner. Only the worker whose plaintext refresh
-- token still matches storage may mark the connection expired.
create or replace function public.mark_xero_connection_if_current(
  p_restaurant_id uuid,
  p_old_refresh   text,
  p_status        text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := public.xero_vault_key();
  v_current text;
begin
  if p_status not in ('expired', 'revoked', 'error') then
    raise exception 'invalid_xero_connection_status';
  end if;
  select extensions.pgp_sym_decrypt(xc.refresh_token_enc, v_key)
  into v_current
  from public.xero_connections xc
  where xc.restaurant_id = p_restaurant_id
  for update;
  if v_current is null or v_current <> p_old_refresh then return false; end if;
  update public.xero_connections
  set status = p_status, updated_at = now()
  where restaurant_id = p_restaurant_id;
  return true;
end;
$$;

-- Atomically install one complete, successfully fetched Xero snapshot. The
-- caller supplies the import start time, not completion time: if two imports
-- overlap, an older slow run cannot overwrite or stale rows from a newer run.
create or replace function public.reconcile_xero_bill_mirror(
  p_restaurant_id uuid,
  p_seen_at       timestamptz,
  p_bills         jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upserted int := 0;
  v_stale_marked int := 0;
  v_seen int := 0;
begin
  if p_seen_at is null or p_bills is null or jsonb_typeof(p_bills) <> 'array' then
    raise exception 'invalid_xero_bill_snapshot';
  end if;
  if not exists (
    select 1 from public.xero_connections xc
    where xc.restaurant_id = p_restaurant_id
  ) then
    raise exception 'xero_connection_not_found';
  end if;

  select count(*) into v_seen
  from jsonb_to_recordset(p_bills) as b(xero_invoice_id text);

  if exists (
    select 1
    from jsonb_to_recordset(p_bills) as b(xero_invoice_id text)
    where b.xero_invoice_id is null
       or b.xero_invoice_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid_xero_invoice_id';
  end if;

  insert into public.xero_bills as xb
    (restaurant_id, xero_invoice_id, contact_name, xero_status, date,
     due_date, total, currency, raw, imported_at, last_seen_at,
     is_stale, stale_at)
  select
    p_restaurant_id,
    lower(b.xero_invoice_id),
    b.contact_name,
    b.xero_status,
    b.invoice_date,
    b.due_date,
    b.total,
    b.currency,
    b.raw,
    p_seen_at,
    p_seen_at,
    false,
    null
  from jsonb_to_recordset(p_bills) as b(
    xero_invoice_id text,
    contact_name text,
    xero_status text,
    invoice_date date,
    due_date date,
    total numeric,
    currency text,
    raw jsonb
  )
  on conflict (restaurant_id, xero_invoice_id) do update
  set contact_name = excluded.contact_name,
      xero_status = excluded.xero_status,
      date = excluded.date,
      due_date = excluded.due_date,
      total = excluded.total,
      currency = excluded.currency,
      raw = excluded.raw,
      imported_at = excluded.imported_at,
      last_seen_at = excluded.last_seen_at,
      is_stale = false,
      stale_at = null
  -- Timestamp fencing makes overlapping full imports deterministic.
  where xb.last_seen_at <= excluded.last_seen_at;
  get diagnostics v_upserted = row_count;

  update public.xero_bills
  set is_stale = true,
      stale_at = coalesce(stale_at, p_seen_at)
  where restaurant_id = p_restaurant_id
    and last_seen_at < p_seen_at
    and not is_stale;
  get diagnostics v_stale_marked = row_count;

  return jsonb_build_object(
    'seen', v_seen,
    'upserted', v_upserted,
    'stale_marked', v_stale_marked
  );
end;
$$;

revoke all on table public.xero_contact_mappings from public, anon, authenticated;
revoke all on table public.xero_invoice_pushes from public, anon, authenticated;

revoke execute on function public.claim_xero_contact_resolution(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.begin_xero_contact_post_attempt(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.release_xero_contact_resolution(uuid, text, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.complete_xero_contact_resolution(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.claim_xero_invoice_push(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.begin_xero_invoice_post_attempt(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.release_xero_invoice_push(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.complete_xero_invoice_push(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.mark_xero_connection_if_current(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.reconcile_xero_bill_mirror(uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.store_xero_tokens(uuid, text, text, timestamptz, text, text, text, uuid) from public, anon, authenticated;

grant execute on function public.claim_xero_contact_resolution(uuid, text, text) to service_role;
grant execute on function public.begin_xero_contact_post_attempt(uuid, text, uuid) to service_role;
grant execute on function public.release_xero_contact_resolution(uuid, text, uuid, text, boolean) to service_role;
grant execute on function public.complete_xero_contact_resolution(uuid, text, uuid, text) to service_role;
grant execute on function public.claim_xero_invoice_push(uuid, uuid) to service_role;
grant execute on function public.begin_xero_invoice_post_attempt(uuid, uuid, uuid) to service_role;
grant execute on function public.release_xero_invoice_push(uuid, uuid, uuid, text, boolean) to service_role;
grant execute on function public.complete_xero_invoice_push(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.mark_xero_connection_if_current(uuid, text, text) to service_role;
grant execute on function public.reconcile_xero_bill_mirror(uuid, timestamptz, jsonb) to service_role;
grant execute on function public.store_xero_tokens(uuid, text, text, timestamptz, text, text, text, uuid) to service_role;
