-- OTP challenges for high-stakes actions (PO approval), plus the approval RPC
-- that consumes a verified challenge.
--
-- The code itself is never stored: only an HMAC-SHA256 hash with a
-- per-challenge salt, computed by the otp-request/otp-verify Edge Functions.
-- Rate limits are enforced here, in SQL, against the challenge table itself:
-- a 60s cooldown per phone, hourly caps per phone and per IP, and a
-- per-challenge attempt counter. The table is deny-all under RLS — user roles
-- never see hashes, phones, or attempt state; the UI learns only what the
-- Edge Functions choose to return.

create table public.otp_challenges (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants (id) on delete cascade,
  user_id              uuid not null references public.profiles (id) on delete cascade,
  phone                text not null,
  channel              text not null check (channel in ('sms', 'whatsapp')),
  purpose              text not null default 'approve_po',
  reference_id         uuid,
  code_hash            text not null,
  salt                 text not null,
  attempts             int not null default 0,
  max_attempts         int not null default 5,
  expires_at           timestamptz not null,
  verified_at          timestamptz,
  consumed_at          timestamptz,
  created_ip           text,
  provider             text,
  provider_message_id  text,
  created_at           timestamptz not null default now()
);

create index otp_challenges_phone_idx on public.otp_challenges (phone, created_at desc);
create index otp_challenges_ip_idx    on public.otp_challenges (created_ip, created_at desc);

alter table public.otp_challenges enable row level security;
-- deny-all: service role only.

-- Called by otp-request before creating a challenge. Returns a verdict the
-- Edge Function relays to the client; the same limits are what an attacker
-- hits, so the numbers are deliberately conservative for a demo.
create or replace function public.check_otp_rate_limit(p_phone text, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_at      timestamptz;
  v_phone_hour   int;
  v_ip_hour      int;
  v_cooldown_sec int := 60;
begin
  select max(created_at) into v_last_at
  from public.otp_challenges where phone = p_phone;

  if v_last_at is not null and v_last_at > now() - make_interval(secs => v_cooldown_sec) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'retry_after_seconds', ceil(extract(epoch from (v_last_at + make_interval(secs => v_cooldown_sec) - now())))::int
    );
  end if;

  select count(*) into v_phone_hour
  from public.otp_challenges
  where phone = p_phone and created_at > now() - interval '1 hour';

  if v_phone_hour >= 5 then
    return jsonb_build_object('allowed', false, 'reason', 'phone_hourly_limit');
  end if;

  if p_ip is not null then
    select count(*) into v_ip_hour
    from public.otp_challenges
    where created_ip = p_ip and created_at > now() - interval '1 hour';

    if v_ip_hour >= 10 then
      return jsonb_build_object('allowed', false, 'reason', 'ip_hourly_limit');
    end if;
  end if;

  return jsonb_build_object('allowed', true);
end;
$$;

revoke execute on function public.check_otp_rate_limit(text, text) from public, anon, authenticated;

-- ------------------------------------------------- OTP-gated approval

-- The final step of the approval flow. otp-verify checks the code hash and
-- stamps verified_at; the app then calls this as the signed-in manager. The
-- challenge must match caller, purpose and document, be verified, unconsumed
-- and fresh — and is consumed here so it can never approve twice.
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
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select id, restaurant_id, po_number, supplier_name, status, total_minor, currency
  into v_po
  from public.purchase_orders where id = p_po_id;

  if v_po.id is null or not public.is_manager(v_po.restaurant_id) then
    raise exception 'manager_required';
  end if;

  if v_po.status <> 'draft' then
    raise exception 'only_drafts_can_be_approved';
  end if;

  select id into v_challenge
  from public.otp_challenges
  where id = p_challenge_id
    and user_id = v_uid
    and purpose = 'approve_po'
    and reference_id = p_po_id
    and verified_at is not null
    and consumed_at is null
    and verified_at > now() - interval '10 minutes';

  if v_challenge.id is null then
    raise exception 'otp_verification_required';
  end if;

  update public.otp_challenges set consumed_at = now() where id = p_challenge_id;

  update public.purchase_orders
  set status = 'approved', approved_by = v_uid, approved_at = now(), updated_at = now()
  where id = p_po_id;

  select coalesce(full_name, email, 'Unknown') into v_approver
  from public.profiles where id = v_uid;

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

  -- Enriched here, like notify_urgent_request: n8n receives resolved names
  -- and never needs database credentials of its own.
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

revoke execute on function public.approve_purchase_order(uuid, uuid) from public, anon;
