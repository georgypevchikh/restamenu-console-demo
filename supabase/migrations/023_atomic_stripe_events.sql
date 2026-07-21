-- Atomic Stripe event application.
--
-- The original Edge Function inserted a `processed` ledger row and then
-- performed the customer/subscription write in a second request. If that
-- second write failed, Stripe's retry saw the ledger row, treated the event as
-- a duplicate, and acknowledged it without ever applying the state change.
--
-- This RPC makes the claim, domain side effect, entitlement trigger, and final
-- ledger status one database transaction:
--
--   * side-effect failure rolls the claim back, so a retry can claim it;
--   * concurrent duplicates serialize on stripe_events.id;
--   * `processed` is written only after the side effect succeeds;
--   * subscription ordering is checked in the conflict UPDATE itself, after
--     acquiring the subscription row lock, not in a racy pre-read.

alter table public.stripe_events
  drop constraint if exists stripe_events_status_check;

alter table public.stripe_events
  add constraint stripe_events_status_check
  check (status in ('processing', 'processed', 'skipped', 'error'));

create or replace function public.apply_stripe_event(
  p_event_id              text,
  p_event_type            text,
  p_decision_kind         text,
  p_reason                text,
  p_restaurant_id         uuid,
  p_customer_id           text,
  p_subscription_id       text,
  p_subscription_status   text,
  p_price_id              text,
  p_current_period_end    timestamptz,
  p_cancel_at_period_end  boolean,
  p_event_created         bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed              text;
  v_restaurant_id        uuid := p_restaurant_id;
  v_affected             int;
  v_existing_restaurant  uuid;
begin
  if p_event_id is null or p_event_id = '' or p_event_type is null or p_event_type = '' then
    raise exception 'invalid_stripe_event_identity';
  end if;

  if p_decision_kind not in ('skip', 'link_customer', 'upsert_subscription') then
    raise exception 'invalid_stripe_decision_kind';
  end if;

  -- The unique event id is the concurrency boundary. A concurrent INSERT with
  -- the same id waits for this transaction: after commit it returns no row and
  -- becomes a duplicate; after rollback it acquires the claim itself.
  insert into public.stripe_events
    (id, type, subscription_id, status, error)
  values
    (
      p_event_id,
      p_event_type,
      p_subscription_id,
      case when p_decision_kind = 'skip' then 'skipped' else 'processing' end,
      case when p_decision_kind = 'skip' then p_reason else null end
    )
  on conflict (id) do nothing
  returning id into v_claimed;

  if v_claimed is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  if p_decision_kind = 'skip' then
    return jsonb_build_object('result', 'skipped', 'reason', p_reason);
  end if;

  if p_decision_kind = 'link_customer' then
    if p_restaurant_id is null or p_customer_id is null or p_customer_id = '' then
      raise exception 'invalid_stripe_customer_mapping';
    end if;

    insert into public.billing_customers (restaurant_id, stripe_customer_id)
    values (p_restaurant_id, p_customer_id)
    on conflict (restaurant_id) do update
      set stripe_customer_id = excluded.stripe_customer_id;

    update public.stripe_events
    set status = 'processed', error = null
    where id = p_event_id;

    return jsonb_build_object('result', 'linked');
  end if;

  -- upsert_subscription
  if p_subscription_id is null or p_subscription_id = ''
     or p_subscription_status is null or p_event_created is null then
    raise exception 'invalid_stripe_subscription_event';
  end if;

  if v_restaurant_id is null and p_customer_id is not null then
    select restaurant_id into v_restaurant_id
    from public.billing_customers
    where stripe_customer_id = p_customer_id;
  end if;

  -- Do not acknowledge an unroutable subscription. The transaction (including
  -- its claim row) rolls back, so Stripe can retry after a delayed customer
  -- mapping arrives instead of permanently poisoning the ledger.
  if v_restaurant_id is null then
    raise exception 'stripe_event_unrouted';
  end if;

  insert into public.subscriptions
    (restaurant_id, stripe_subscription_id, status, price_id,
     current_period_end, cancel_at_period_end, last_event_created, updated_at)
  values
    (v_restaurant_id, p_subscription_id, p_subscription_status, p_price_id,
     p_current_period_end, coalesce(p_cancel_at_period_end, false), p_event_created, now())
  on conflict (stripe_subscription_id) do update
    set status               = excluded.status,
        price_id             = excluded.price_id,
        current_period_end   = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        last_event_created   = excluded.last_event_created,
        updated_at           = now()
    where public.subscriptions.restaurant_id = excluded.restaurant_id
      and public.subscriptions.last_event_created <= excluded.last_event_created;

  get diagnostics v_affected = row_count;

  if v_affected = 0 then
    select restaurant_id into v_existing_restaurant
    from public.subscriptions
    where stripe_subscription_id = p_subscription_id;

    if v_existing_restaurant is distinct from v_restaurant_id then
      raise exception 'stripe_subscription_tenant_mismatch';
    end if;

    update public.stripe_events
    set status = 'skipped', error = 'stale event (older than last applied)'
    where id = p_event_id;

    return jsonb_build_object('result', 'stale');
  end if;

  -- The subscription write and its entitlement/audit/outbox trigger have all
  -- succeeded inside this transaction. Only now is the event processed.
  update public.stripe_events
  set status = 'processed', error = null
  where id = p_event_id;

  return jsonb_build_object('result', 'applied', 'status', p_subscription_status);
end;
$$;

revoke execute on function public.apply_stripe_event(
  text, text, text, text, uuid, text, text, text, text, timestamptz, boolean, bigint
) from public, anon, authenticated;

grant execute on function public.apply_stripe_event(
  text, text, text, text, uuid, text, text, text, text, timestamptz, boolean, bigint
) to service_role;

comment on function public.apply_stripe_event(
  text, text, text, text, uuid, text, text, text, text, timestamptz, boolean, bigint
) is 'Atomically claim and apply one verified Stripe webhook event; safe under retries and concurrent duplicate deliveries.';
