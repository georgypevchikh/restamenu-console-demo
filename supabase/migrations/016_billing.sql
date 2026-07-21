-- Stripe billing: customer mapping, subscription mirror, entitlements, and an
-- idempotency ledger for webhook events.
--
-- Nothing here is written by a user. The stripe-webhook Edge Function (service
-- role) is the only writer; the app reads subscription state and entitlements
-- through RLS. The feature gate the app checks is has_entitlement() — the
-- subscription row is bookkeeping, the entitlement row is the decision.

create table public.billing_customers (
  restaurant_id       uuid primary key references public.restaurants (id) on delete cascade,
  stripe_customer_id  text not null unique,
  created_at          timestamptz not null default now()
);

create table public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  restaurant_id           uuid not null references public.restaurants (id) on delete cascade,
  stripe_subscription_id  text not null unique,
  status                  text not null
                            check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active',
                                              'past_due', 'canceled', 'unpaid', 'paused')),
  price_id                text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  -- Stripe does not guarantee event ordering. Each applied event stores its
  -- `created` timestamp here; the webhook ignores events older than the last
  -- one applied, so a delayed `updated` cannot overwrite a newer `deleted`.
  last_event_created      bigint not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index subscriptions_restaurant_idx on public.subscriptions (restaurant_id);

create table public.entitlements (
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  feature        text not null,
  active         boolean not null default false,
  source         text,
  updated_at     timestamptz not null default now(),
  primary key (restaurant_id, feature)
);

-- Idempotency ledger: every received webhook event id lands here exactly once
-- (insert .. on conflict do nothing). A second delivery of the same event is
-- acknowledged to Stripe and skipped.
create table public.stripe_events (
  id               text primary key,        -- evt_...
  type             text not null,
  subscription_id  text,
  status           text not null default 'processed'
                     check (status in ('processed', 'skipped', 'error')),
  error            text,
  received_at      timestamptz not null default now()
);

alter table public.billing_customers enable row level security;
alter table public.subscriptions     enable row level security;
alter table public.entitlements      enable row level security;
alter table public.stripe_events     enable row level security;

create policy "billing_customers: member read" on public.billing_customers
  for select using (public.is_member(restaurant_id));
create policy "subscriptions: member read" on public.subscriptions
  for select using (public.is_member(restaurant_id));
create policy "entitlements: member read" on public.entitlements
  for select using (public.is_member(restaurant_id));
-- stripe_events: no policies — service role only.

-- The single feature gate used by RPCs, Edge Functions and the UI.
create or replace function public.has_entitlement(p_restaurant_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements
    where restaurant_id = p_restaurant_id
      and feature = p_feature
      and active
  );
$$;

-- Subscription state → entitlement, audit row and outbox event, all in the
-- same transaction as the subscription write.
create or replace function public.sync_entitlement_from_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean := new.status in ('active', 'trialing');
begin
  insert into public.entitlements (restaurant_id, feature, active, source, updated_at)
  values (new.restaurant_id, 'billing_pro', v_active, 'stripe:' || new.stripe_subscription_id, now())
  on conflict (restaurant_id, feature) do update
    set active = excluded.active,
        source = excluded.source,
        updated_at = now();

  if tg_op = 'INSERT' or old.status is distinct from new.status then
    perform public.log_audit(
      new.restaurant_id, null, 'stripe',
      'subscription.status_changed', 'subscription', new.id,
      jsonb_build_object(
        'from', case when tg_op = 'INSERT' then null else old.status end,
        'to', new.status,
        'entitlement_active', v_active
      )
    );
    perform public.emit_outbox_event(
      new.restaurant_id, 'subscription.status_changed',
      jsonb_build_object(
        'stripeSubscriptionId', new.stripe_subscription_id,
        'status', new.status,
        'entitlementActive', v_active
      )
    );
  end if;

  return new;
end;
$$;

create trigger subscription_entitlement_sync
  after insert or update on public.subscriptions
  for each row
  execute function public.sync_entitlement_from_subscription();
