-- Urgent purchase request → n8n → Telegram
--
-- Fires only for priority = 'urgent' (enforced in the trigger WHEN clause, so
-- normal-priority inserts never reach the function at all).
--
-- The payload is enriched here rather than by a callback from the automation
-- layer: n8n receives product/restaurant names already resolved and never needs
-- database credentials of its own.
--
-- The endpoint lives in Supabase Vault, not in this file — this repository is
-- public, and anyone holding the URL can post arbitrary alerts.

-- Replaces the dashboard-created webhook, which fired on every insert.
drop trigger if exists urgent_request_alert on public.purchase_requests;

create or replace function public.notify_urgent_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url     text;
  v_payload jsonb;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'n8n_urgent_webhook_url';

  if v_url is null then
    raise warning 'notify_urgent_request: vault secret n8n_urgent_webhook_url not found; skipping';
    return null;
  end if;

  select jsonb_build_object(
    'request_id',      new.id,
    'quantity',        new.quantity,
    'priority',        new.priority,
    'status',          new.status,
    'created_at',      new.created_at,
    'product_name',    p.name,
    'product_unit',    p.unit,
    'restaurant_name', r.name,
    'requested_by',    coalesce(prof.full_name, 'Unknown')
  )
  into v_payload
  from public.products p
  join public.restaurants r    on r.id = new.restaurant_id
  left join public.profiles prof on prof.id = new.created_by
  where p.id = new.product_id;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := v_payload,
    timeout_milliseconds := 5000
  );

  return null;
end;
$$;

comment on function public.notify_urgent_request() is
  'AFTER INSERT trigger on purchase_requests: posts an enriched urgent-request payload to the n8n webhook stored in Vault.';

-- AFTER trigger on a fired-once-per-row event: return value is ignored, so the
-- function returns null and the insert is unaffected either way.
create trigger urgent_request_alert
  after insert on public.purchase_requests
  for each row
  when (new.priority = 'urgent')
  execute function public.notify_urgent_request();
