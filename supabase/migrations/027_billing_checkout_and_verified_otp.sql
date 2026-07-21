-- Close the remaining billing/approval trust boundaries:
--   1. Entitlements are derived from the aggregate of every Stripe
--      subscription for a restaurant, not whichever row fired last.
--   2. Checkout creation is claimed in Postgres before calling Stripe. A
--      fenced, reusable token is the Stripe idempotency key after an ambiguous
--      network failure, while concurrent browser requests share one session.
--   3. Approval OTPs are delivered only to an out-of-band verified profile
--      destination. A browser can select SMS vs WhatsApp, never the phone.

-- ============================================================================
-- Stripe subscription aggregate -> one entitlement.

drop trigger if exists subscription_entitlement_sync on public.subscriptions;

create or replace function public.sync_entitlement_from_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid := coalesce(new.restaurant_id, old.restaurant_id);
  v_subscription_id uuid := coalesce(new.id, old.id);
  v_stripe_subscription_id text := coalesce(
    new.stripe_subscription_id,
    old.stripe_subscription_id
  );
  v_status text := case when tg_op = 'DELETE' then 'deleted' else new.status end;
  v_previous_active boolean;
  v_active boolean;
begin
  select e.active
  into v_previous_active
  from public.entitlements e
  where e.restaurant_id = v_restaurant_id
    and e.feature = 'billing_pro';

  select exists (
    select 1
    from public.subscriptions s
    where s.restaurant_id = v_restaurant_id
      and s.status in ('active', 'trialing')
  ) into v_active;

  insert into public.entitlements
    (restaurant_id, feature, active, source, updated_at)
  values
    (v_restaurant_id, 'billing_pro', v_active, 'stripe:aggregate', now())
  on conflict (restaurant_id, feature) do update
    set active = excluded.active,
        source = excluded.source,
        updated_at = now();

  if tg_op in ('INSERT', 'DELETE')
     or old.status is distinct from new.status
     or v_previous_active is distinct from v_active then
    perform public.log_audit(
      v_restaurant_id,
      null,
      'stripe',
      'subscription.status_changed',
      'subscription',
      v_subscription_id,
      jsonb_build_object(
        'operation', lower(tg_op),
        'from', case when tg_op = 'INSERT' then null else old.status end,
        'to', v_status,
        'stripeSubscriptionId', v_stripe_subscription_id,
        'entitlementActive', v_active
      )
    );
    perform public.emit_outbox_event(
      v_restaurant_id,
      'subscription.status_changed',
      jsonb_build_object(
        'stripeSubscriptionId', v_stripe_subscription_id,
        'status', v_status,
        'entitlementActive', v_active
      )
    );
  end if;

  return coalesce(new, old);
end;
$$;

create trigger subscription_entitlement_sync
  after insert or update or delete on public.subscriptions
  for each row
  execute function public.sync_entitlement_from_subscription();

revoke execute on function public.sync_entitlement_from_subscription()
  from public, anon, authenticated, service_role;

-- ============================================================================
-- Stripe Checkout claim/fencing ledger. There are intentionally no RLS
-- policies: only the two service-role RPCs below can observe or mutate it.

create table public.billing_checkout_claims (
  restaurant_id       uuid primary key
                        references public.restaurants (id) on delete cascade,
  state               text not null
                        check (state in ('creating', 'ready')),
  claim_token         uuid not null,
  lease_until         timestamptz not null,
  stripe_session_id   text,
  session_url         text,
  checkout_expires_at timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint billing_checkout_ready_shape check (
    (state = 'creating' and stripe_session_id is null and session_url is null)
    or
    (state = 'ready' and stripe_session_id is not null and session_url is not null)
  )
);

alter table public.billing_checkout_claims enable row level security;
revoke all on table public.billing_checkout_claims from anon, authenticated;

create or replace function public.claim_billing_checkout(
  p_restaurant_id uuid,
  p_user_id uuid
) returns table (
  outcome text,
  claim_token uuid,
  session_url text,
  checkout_expires_at timestamptz,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.billing_checkout_claims%rowtype;
  v_token uuid;
begin
  if p_restaurant_id is null or p_user_id is null then
    raise exception 'checkout_identity_required';
  end if;
  if not exists (
    select 1
    from public.restaurant_members rm
    where rm.restaurant_id = p_restaurant_id
      and rm.user_id = p_user_id
      and rm.role = 'manager'
  ) then
    raise exception 'manager_required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('billing-checkout:' || p_restaurant_id::text, 0)
  );

  if public.has_entitlement(p_restaurant_id, 'billing_pro') then
    return query
      select 'already_entitled'::text, null::uuid, null::text,
             null::timestamptz, null::integer;
    return;
  end if;

  select c.*
  into v_claim
  from public.billing_checkout_claims c
  where c.restaurant_id = p_restaurant_id
  for update;

  if found and v_claim.checkout_expires_at > now() then
    if v_claim.state = 'ready' then
      return query
        select 'ready'::text, v_claim.claim_token, v_claim.session_url,
               v_claim.checkout_expires_at, null::integer;
      return;
    end if;

    if v_claim.lease_until > now() then
      return query
        select 'busy'::text, null::uuid, null::text,
               v_claim.checkout_expires_at,
               greatest(
                 1,
                 ceil(extract(epoch from (v_claim.lease_until - now())))::integer
               );
      return;
    end if;

    -- The previous worker may have reached Stripe and lost the response.
    -- Reusing this token makes the retry converge on that same session.
    update public.billing_checkout_claims c
    set lease_until = now() + interval '90 seconds',
        updated_at = now()
    where c.restaurant_id = p_restaurant_id;

    return query
      select 'claimed'::text, v_claim.claim_token, null::text,
             v_claim.checkout_expires_at, null::integer;
    return;
  end if;

  v_token := gen_random_uuid();
  insert into public.billing_checkout_claims as c
    (restaurant_id, state, claim_token, lease_until,
     checkout_expires_at, stripe_session_id, session_url, updated_at)
  values
    (p_restaurant_id, 'creating', v_token, now() + interval '90 seconds',
     now() + interval '31 minutes', null, null, now())
  on conflict (restaurant_id) do update
    set state = 'creating',
        claim_token = excluded.claim_token,
        lease_until = excluded.lease_until,
        checkout_expires_at = excluded.checkout_expires_at,
        stripe_session_id = null,
        session_url = null,
        updated_at = now();

  return query
    select 'claimed'::text, v_token, null::text,
           now() + interval '31 minutes', null::integer;
end;
$$;

create or replace function public.complete_billing_checkout(
  p_restaurant_id uuid,
  p_claim_token uuid,
  p_stripe_session_id text,
  p_session_url text,
  p_checkout_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_restaurant_id is null
     or p_claim_token is null
     or p_stripe_session_id is null
     or p_stripe_session_id !~ '^cs_(test|live)_[A-Za-z0-9_]+'
     or p_session_url is null
     or length(p_session_url) > 4096
     or p_session_url !~ '^https://checkout[.]stripe[.]com/'
     or p_checkout_expires_at <= now()
     or p_checkout_expires_at > now() + interval '2 hours' then
    raise exception 'invalid_checkout_session';
  end if;

  update public.billing_checkout_claims c
  set state = 'ready',
      stripe_session_id = p_stripe_session_id,
      session_url = p_session_url,
      checkout_expires_at = p_checkout_expires_at,
      lease_until = now(),
      updated_at = now()
  where c.restaurant_id = p_restaurant_id
    and c.state = 'creating'
    and c.claim_token = p_claim_token
    and c.checkout_expires_at > now();

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke execute on function public.claim_billing_checkout(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_billing_checkout(uuid, uuid)
  to service_role;
revoke execute on function public.complete_billing_checkout(
  uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_billing_checkout(
  uuid, uuid, text, text, timestamptz
) to service_role;

-- ============================================================================
-- Verified approval destinations. Phone values are not readable or writable
-- through the browser's authenticated role, including by the profile owner.

alter table public.profiles
  add column approval_phone_e164 text,
  add column approval_phone_verified_at timestamptz,
  add constraint profiles_approval_phone_shape check (
    (approval_phone_e164 is null and approval_phone_verified_at is null)
    or
    (
      approval_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
      and approval_phone_verified_at is not null
    )
  );

create unique index profiles_approval_phone_unique
  on public.profiles (approval_phone_e164)
  where approval_phone_e164 is not null;

revoke select, update on table public.profiles from anon, authenticated;
grant select (id, email, full_name, avatar_url, created_at)
  on table public.profiles to authenticated;
grant update (email, full_name, avatar_url)
  on table public.profiles to authenticated;

create or replace function public.issue_profile_otp_challenge(
  p_restaurant_id uuid,
  p_user_id uuid,
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
  retry_after_seconds integer,
  destination_phone text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  select p.approval_phone_e164
  into v_phone
  from public.profiles p
  where p.id = p_user_id
    and p.approval_phone_e164 is not null
    and p.approval_phone_verified_at is not null;

  if v_phone is null then
    raise exception 'approval_phone_not_configured';
  end if;

  return query
  select
    issued.outcome,
    issued.challenge_id,
    issued.retry_after_seconds,
    v_phone
  from public.issue_otp_challenge(
    p_restaurant_id,
    p_user_id,
    v_phone,
    p_channel,
    p_purpose,
    p_reference_id,
    p_code_hash,
    p_salt,
    p_expires_at,
    p_ip,
    p_provider
  ) issued;
end;
$$;

-- Make the destination-bound wrapper the only service-role issuance path.
revoke execute on function public.issue_otp_challenge(
  uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text
) from service_role;
revoke execute on function public.issue_profile_otp_challenge(
  uuid, uuid, text, text, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.issue_profile_otp_challenge(
  uuid, uuid, text, text, uuid, text, text, timestamptz, text, text
) to service_role;

comment on column public.profiles.approval_phone_e164 is
  'Out-of-band verified E.164 destination for approval OTPs; service-only.';
