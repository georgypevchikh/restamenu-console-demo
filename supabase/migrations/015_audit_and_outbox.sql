-- Audit trail + transactional outbox.
--
-- audit_events is the tenant-visible "what happened" ledger: domain
-- transitions, webhook effects, sync attempts. Members read their own
-- restaurant's rows; nothing is ever written to it directly by a user — only
-- through log_audit(), called from RPCs and triggers.
--
-- outbox_events implements the transactional-outbox pattern in pure Postgres:
-- domain triggers insert an event in the SAME transaction as the change, and
-- two pg_cron sweeps deliver it to n8n through pg_net. pg_net is async — the
-- POST returns a request id immediately and the HTTP response lands in
-- net._http_response later — so delivery is a two-step state machine:
--
--   pending → (process_outbox posts, stores request id) → delivering
--   delivering → (reconcile_outbox matches the response) → delivered | pending(retry) | failed
--
-- Retries back off exponentially (2^attempts minutes) up to max_attempts.
-- The webhook URL and its auth header live in Vault: the repo is public, and
-- the n8n workflow authenticates with a dedicated random secret — never a
-- database credential.

-- ---------------------------------------------------------------- audit

create table public.audit_events (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  actor_id       uuid references public.profiles (id) on delete set null,
  actor_type     text not null default 'user'
                   check (actor_type in ('user', 'system', 'stripe', 'xero', 'otp', 'outbox')),
  action         text not null,
  entity_type    text,
  entity_id      uuid,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index audit_events_restaurant_created_idx
  on public.audit_events (restaurant_id, created_at desc);

alter table public.audit_events enable row level security;

create policy "audit: member read" on public.audit_events
  for select using (public.is_member(restaurant_id));

-- SECURITY DEFINER so triggers and RPCs can write regardless of the caller's
-- RLS context. Not granted to users: the only writers are our own functions.
create or replace function public.log_audit(
  p_restaurant_id uuid,
  p_actor_id      uuid,
  p_actor_type    text,
  p_action        text,
  p_entity_type   text,
  p_entity_id     uuid,
  p_detail        jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.audit_events
    (restaurant_id, actor_id, actor_type, action, entity_type, entity_id, detail)
  values
    (p_restaurant_id, p_actor_id, p_actor_type, p_action, p_entity_type, p_entity_id, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.log_audit(uuid, uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- outbox

create table public.outbox_events (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants (id) on delete cascade,
  event_type       text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending'
                     check (status in ('pending', 'delivering', 'delivered', 'failed')),
  attempts         int not null default 0,
  max_attempts     int not null default 5,
  next_attempt_at  timestamptz not null default now(),
  last_attempt_at  timestamptz,
  http_request_id  bigint,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index outbox_events_due_idx
  on public.outbox_events (status, next_attempt_at);
create index outbox_events_restaurant_created_idx
  on public.outbox_events (restaurant_id, created_at desc);

alter table public.outbox_events enable row level security;

-- Members may watch their own events move through the state machine (the
-- audit timeline UI shows delivery attempts); they cannot write.
create policy "outbox: member read" on public.outbox_events
  for select using (public.is_member(restaurant_id));

create or replace function public.emit_outbox_event(
  p_restaurant_id uuid,
  p_event_type    text,
  p_payload       jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.outbox_events (restaurant_id, event_type, payload)
  values (p_restaurant_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.emit_outbox_event(uuid, text, jsonb) from public, anon, authenticated;

-- Step 1: post due events. Follows the notify_urgent_request pattern — if the
-- Vault secrets are not configured yet, events simply stay pending and the
-- sweep is a no-op, so this migration is safe to apply before n8n exists.
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

  if v_url is null then
    return 0;
  end if;

  select decrypted_secret into v_auth
  from vault.decrypted_secrets where name = 'n8n_outbox_auth';

  for r in
    select id, restaurant_id, event_type, payload
    from public.outbox_events
    where status in ('pending')
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
        'Authorization', coalesce(v_auth, '')
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

-- Step 2: settle in-flight events against pg_net responses. Unmatched
-- 'delivering' rows older than 10 minutes are treated as lost (pg_net prunes
-- its response table) and go back through the retry path.
create or replace function public.reconcile_outbox()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    select o.id, o.attempts, o.max_attempts,
           resp.status_code, resp.error_msg,
           (o.last_attempt_at < now() - interval '10 minutes') as stale
    from public.outbox_events o
    left join net._http_response resp on resp.id = o.http_request_id
    where o.status = 'delivering'
    for update of o skip locked
  loop
    if r.status_code between 200 and 299 then
      update public.outbox_events
      set status = 'delivered', delivered_at = now(), last_error = null
      where id = r.id;
      v_count := v_count + 1;

    elsif r.status_code is not null or r.error_msg is not null or r.stale then
      if r.attempts >= r.max_attempts then
        update public.outbox_events
        set status     = 'failed',
            last_error = coalesce('HTTP ' || r.status_code, r.error_msg, 'no response within 10 minutes')
        where id = r.id;
      else
        update public.outbox_events
        set status          = 'pending',
            next_attempt_at = now() + (power(2, r.attempts) * interval '1 minute'),
            last_error      = coalesce('HTTP ' || r.status_code, r.error_msg, 'no response within 10 minutes')
        where id = r.id;
      end if;
      v_count := v_count + 1;
    end if;
    -- else: response not arrived yet and not stale — leave it in flight
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.process_outbox() from public, anon, authenticated;
revoke execute on function public.reconcile_outbox() from public, anon, authenticated;

-- Sweeps every minute. Both are cheap no-ops when there is nothing to do.
select cron.schedule('process-outbox',   '* * * * *', $$select public.process_outbox()$$);
select cron.schedule('reconcile-outbox', '* * * * *', $$select public.reconcile_outbox()$$);
