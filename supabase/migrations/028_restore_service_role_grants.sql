-- Restore service_role EXECUTE on two functions that lost the grant when
-- migrations 024/026 redefined them with `create or replace` after a
-- `revoke ... from public`. The Edge Functions call these through the
-- service-role client, so without the grant the call fails with a permission
-- error that surfaces to the browser as a 500:
--   * issue_otp_challenge            — otp-request (approve-PO OTP issuance)
--   * calculate_purchase_order_authoritative — server-side PO repricing
--
-- The other definer functions (apply_stripe_event, claim_otp_attempt,
-- mark_otp_verified, the xero_* helpers, log_audit) kept their grants; only
-- these two regressed.

grant execute on function public.issue_otp_challenge(
  uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text
) to service_role;

grant execute on function public.calculate_purchase_order_authoritative(
  uuid, uuid, integer, jsonb
) to service_role;
