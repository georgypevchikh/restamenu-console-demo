-- Function ACLs in one auditable place.
--
-- Postgres grants EXECUTE to PUBLIC on function creation; the migrations
-- above revoke that. But revoking PUBLIC also strips the implicit path for
-- authenticated and service_role — so each function gets exactly the grants
-- its callers need, and nothing else:
--
--   authenticated  → RPCs the app calls with a signed-in user
--   service_role   → helpers the Edge Functions call
--   (definer-to-definer calls run as the function owner and need no grant)

-- App-facing RPCs
grant execute on function public.create_purchase_order(text, text, uuid, int, jsonb, jsonb, jsonb, jsonb, bigint, bigint, bigint, bigint) to authenticated;
grant execute on function public.cancel_purchase_order(uuid) to authenticated;
grant execute on function public.approve_purchase_order(uuid, uuid) to authenticated;
grant execute on function public.has_entitlement(uuid, text) to authenticated;
grant execute on function public.xero_connection_status(uuid) to authenticated;

-- Edge-Function-facing helpers (service_role only)
grant execute on function public.log_audit(uuid, uuid, text, text, text, uuid, jsonb) to service_role;
grant execute on function public.emit_outbox_event(uuid, text, jsonb) to service_role;
grant execute on function public.has_entitlement(uuid, text) to service_role;
grant execute on function public.store_xero_tokens(uuid, text, text, timestamptz, text, text, text, uuid) to service_role;
grant execute on function public.get_xero_tokens(uuid) to service_role;
grant execute on function public.update_xero_tokens_if_current(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.mark_xero_connection(uuid, text) to service_role;
grant execute on function public.check_otp_rate_limit(text, text) to service_role;

-- Sweeps are invoked by pg_cron as the owning role; nothing else may call them.
-- (No additional grants.)
