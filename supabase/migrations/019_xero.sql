-- Xero integration: OAuth connection state, encrypted token storage, a sync
-- journal, and a mirror of imported bills.
--
-- Token security model: access/refresh tokens are pgp_sym_encrypt-ed with a
-- key that lives only in Vault ('xero_token_key'). The table is deny-all under
-- RLS; the only readers/writers are SECURITY DEFINER functions that user roles
-- cannot execute — in practice that means the xero-* Edge Functions running as
-- service_role. The app learns connection state through
-- xero_connection_status(), which never returns token material.
--
-- Xero rotates the refresh token on every refresh. update_xero_tokens_if_current()
-- makes the rotation compare-and-swap: a concurrent refresh that lost the race
-- gets `false` back and must re-read instead of clobbering the newer token.

create table public.xero_connections (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null unique references public.restaurants (id) on delete cascade,
  xero_tenant_id     text,
  xero_tenant_name   text,
  access_token_enc   bytea,
  refresh_token_enc  bytea,
  access_expires_at  timestamptz,
  scopes             text,
  status             text not null default 'connected'
                       check (status in ('connected', 'expired', 'revoked', 'error')),
  connected_by       uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Browser redirects carry no JWT, so the OAuth callback correlates through a
-- short-lived state row created by xero-oauth-start.
create table public.xero_oauth_states (
  state          text primary key,
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  redirect_to    text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '10 minutes'
);

create table public.xero_sync_log (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  operation      text not null
                   check (operation in ('oauth_connect', 'token_refresh', 'invoice_push', 'bill_import')),
  direction      text not null check (direction in ('push', 'pull', 'auth')),
  status         text not null check (status in ('success', 'error')),
  xero_id        text,
  summary        jsonb not null default '{}'::jsonb,
  error          text,
  created_at     timestamptz not null default now()
);

create index xero_sync_log_restaurant_idx
  on public.xero_sync_log (restaurant_id, created_at desc);

create table public.xero_bills (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants (id) on delete cascade,
  xero_invoice_id  text not null,
  contact_name     text,
  xero_status      text,
  date             date,
  due_date         date,
  total            numeric(12,2),
  currency         text,
  raw              jsonb,
  imported_at      timestamptz not null default now(),
  unique (restaurant_id, xero_invoice_id)
);

alter table public.xero_connections  enable row level security;
alter table public.xero_oauth_states enable row level security;
alter table public.xero_sync_log     enable row level security;
alter table public.xero_bills        enable row level security;

-- connections/oauth_states: deny-all — service role and definer functions only.
create policy "xero_sync_log: member read" on public.xero_sync_log
  for select using (public.is_member(restaurant_id));
create policy "xero_bills: member read" on public.xero_bills
  for select using (public.is_member(restaurant_id));

-- ------------------------------------------------- token access functions

create or replace function public.xero_vault_key()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'xero_token_key';
  if v_key is null then
    raise exception 'xero_token_key_not_configured';
  end if;
  return v_key;
end;
$$;

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
begin
  insert into public.xero_connections
    (restaurant_id, xero_tenant_id, xero_tenant_name,
     access_token_enc, refresh_token_enc, access_expires_at,
     scopes, status, connected_by, updated_at)
  values
    (p_restaurant_id, p_tenant_id, p_tenant_name,
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
        updated_at        = now();

  perform public.log_audit(
    p_restaurant_id, p_connected_by, 'xero',
    'xero.connected', 'xero_connection', null,
    jsonb_build_object('tenant_name', p_tenant_name)
  );
end;
$$;

create or replace function public.get_xero_tokens(p_restaurant_id uuid)
returns table (
  access_token      text,
  refresh_token     text,
  access_expires_at timestamptz,
  xero_tenant_id    text,
  status            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := public.xero_vault_key();
begin
  return query
  select
    extensions.pgp_sym_decrypt(c.access_token_enc, v_key),
    extensions.pgp_sym_decrypt(c.refresh_token_enc, v_key),
    c.access_expires_at,
    c.xero_tenant_id,
    c.status
  from public.xero_connections c
  where c.restaurant_id = p_restaurant_id;
end;
$$;

-- Compare-and-swap for refresh rotation: only applies the new pair when the
-- stored refresh token still equals the one this caller refreshed with.
create or replace function public.update_xero_tokens_if_current(
  p_restaurant_id uuid,
  p_old_refresh   text,
  p_new_access    text,
  p_new_refresh   text,
  p_expires_at    timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text := public.xero_vault_key();
  v_current text;
begin
  select extensions.pgp_sym_decrypt(refresh_token_enc, v_key) into v_current
  from public.xero_connections
  where restaurant_id = p_restaurant_id
  for update;

  if v_current is null or v_current <> p_old_refresh then
    return false;
  end if;

  update public.xero_connections
  set access_token_enc  = extensions.pgp_sym_encrypt(p_new_access, v_key),
      refresh_token_enc = extensions.pgp_sym_encrypt(p_new_refresh, v_key),
      access_expires_at = p_expires_at,
      status            = 'connected',
      updated_at        = now()
  where restaurant_id = p_restaurant_id;

  return true;
end;
$$;

create or replace function public.mark_xero_connection(p_restaurant_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.xero_connections
  set status = p_status, updated_at = now()
  where restaurant_id = p_restaurant_id;
end;
$$;

-- Token material never crosses this boundary — safe to expose to members.
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
  if not public.is_member(p_restaurant_id) then
    raise exception 'not_a_member';
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

revoke execute on function public.xero_vault_key() from public, anon, authenticated;
revoke execute on function public.store_xero_tokens(uuid, text, text, timestamptz, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.get_xero_tokens(uuid) from public, anon, authenticated;
revoke execute on function public.update_xero_tokens_if_current(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_xero_connection(uuid, text) from public, anon, authenticated;
revoke execute on function public.xero_connection_status(uuid) from public, anon;
