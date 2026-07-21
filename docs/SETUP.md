# Billing & Supplier Sync — setup guide

How to wire the deployed demo to its external sandboxes. The code, database
migrations and Edge Functions are already in place; everything below is
account setup and secret configuration. Each function answers
`503 { error: "not_configured", missing: [...] }` until its secrets exist, so
you can verify progress with curl at every step.

**Design invariant:** the web deployment keeps only the Supabase URL + anon
key. Every secret below goes into Edge Function secrets or Supabase Vault —
never into Vercel.

```bash
# All function secrets are set like this:
supabase secrets set NAME=value --project-ref <PROJECT_REF>
# Vault secrets are set in SQL:
#   select vault.create_secret('<value>', '<name>');
```

## 1. Stripe (test mode) — ~15 min

1. Create a Stripe account (or use an existing one); stay in **test mode**.
2. Products → create product `Restamenu Pro`, recurring monthly price
   (e.g. €29). Copy the price id (`price_…`).
3. Developers → API keys → copy the **secret key** (`sk_test_…`).
4. Developers → Webhooks → add endpoint:
   - URL: `https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`,
     `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the signing secret (`whsec_…`).
5. Set the secrets:

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_… \
  STRIPE_PRICE_ID=price_… \
  STRIPE_WEBHOOK_SECRET=whsec_… \
  APP_BASE_URL=https://<your-app>.vercel.app \
  --project-ref <PROJECT_REF>
```

`APP_BASE_URL` must be the application origin only (HTTPS, no path, query, or
fragment). Checkout success/cancel URLs are derived inside the Edge Function;
the browser cannot supply a redirect target.

6. Verify: sign in to the app as the free tenant → Billing → Upgrade to Pro →
   card `4242 4242 4242 4242`, any future expiry, any CVC. Within seconds the
   webhook activates the subscription, the trigger grants the entitlement,
   and Orders/Xero/Audit unlock. `stripe_events` records every delivery;
   resending an event from the Stripe dashboard demonstrates idempotency.
7. Optional (Test Clocks): create a test clock, attach a new customer and
   subscription, advance time past the period end to exercise
   `past_due`/`canceled` → entitlement revocation.

## 2. Xero (demo company) — ~20 min

1. Create a free Xero account and enable the **Demo Company** (My Xero →
   Try the Demo Company).
2. developer.xero.com → New app → Web app:
   - Redirect URI: `https://<PROJECT_REF>.supabase.co/functions/v1/xero-oauth-callback`
   - Copy client id + client secret.
   - For this demo, authorise exactly one organisation. The callback refuses
     to guess when `/connections` returns multiple tenants; disconnect old
     test organisations first (explicit tenant selection is not in this MVP).
   - Reauthorising the same organisation is safe. Switching an existing
     restaurant to a different Xero organisation is deliberately rejected:
     persisted ContactIDs/InvoiceIDs belong to the original tenant and require
     an explicit audited reset workflow, which is outside this MVP.
3. Set secrets + the token-encryption key:

```bash
supabase secrets set \
  XERO_CLIENT_ID=… \
  XERO_CLIENT_SECRET=… \
  XERO_REDIRECT_URI=https://<PROJECT_REF>.supabase.co/functions/v1/xero-oauth-callback \
  XERO_DEFAULT_ACCOUNT_CODE=310 \
  APP_BASE_URL=https://<your-app>.vercel.app \
  --project-ref <PROJECT_REF>
```

`XERO_DEFAULT_ACCOUNT_CODE` is required for PO pushes and must be an active
expense/direct-cost code in the connected organisation (the demo company often
uses `310`, but verify its chart first). Bill import and OAuth do not need it.

```sql
-- Vault: key that encrypts tokens at rest (any long random string)
select vault.create_secret('<64+ random chars>', 'xero_token_key');
```

4. Verify: app → Xero → Connect Xero demo company → authorise → redirected
   back with “Connected”. Approve a PO → Push to Xero → the draft bill
   appears in the demo company (Business → Bills to pay). Import bills pulls
   them back. The first push also resolves or creates the supplier Contact and
   persists its Xero `ContactID`; new contacts also receive a deterministic
   Restamenu `ContactNumber`. The bill payload refers to `ContactID`, not a
   display name. Its line totals, tax summary, and negative withholding
   adjustment are sent as explicit `NoTax` lines, and the returned Xero Total
   must equal the authoritative PO total before local completion. Every
   operation lands in the sync journal. Bill import walks every API page; only
   after a complete fetch does one SQL transaction refresh the mirror and mark
   formerly imported bills that are now absent as `is_stale`.

**Retry verification.** After the first successful push, clear only the local
PO `xero_invoice_id` in a disposable demo tenant (leave the Xero bill intact),
then push again. The function must find the existing bill by the deterministic
`RM:<restaurant-id>:<po-number>` Reference and repair local state without a
second POST. Also verify that two exact-name Contacts or two bills with the
same Reference produce a `409` ambiguity response rather than an arbitrary
match.

Xero's idempotency cache is a short request-attempt guard, not permanent
deduplication. Restamenu stores each attempt timestamp, reuses a key only
inside a 5m30 safety window, and reconciles Xero before rotating to a fresh
key. Residual sandbox checks are still required for the connected demo
company’s Contact search behaviour, chart-of-accounts code, and permission
scopes. Confirm in the demo company that its regional configuration accepts
the explicit negative withholding line. This demo preserves the payable total;
mapping Restamenu's tax trace into jurisdiction-specific Xero TaxTypes/accounts
is intentionally a later accounting-configuration task. No unit test can
prove an external tenant's configuration.

**Import verification.** Create more than 100 demo bills (or temporarily lower
the local page-size test fixture), run Import, and verify that rows from page 2
exist. In a disposable demo organisation, remove an invoice from the ACCPAY
query, import again, and verify its existing mirror row becomes `is_stale`
instead of silently looking current. Force a page-2 failure and confirm no
rows are marked stale from that incomplete run.

## 3. OTP delivery (Twilio, or explicit local-demo console mode)

The function fails closed when `OTP_PROVIDER` is absent or misspelled. For a
local/private demo only, explicitly enable the console adapter; codes are then
printed to the `otp-request` logs and are not delivered to a phone:

```bash
supabase secrets set OTP_PROVIDER=console --project-ref <PROJECT_REF>
```

Do not use console mode for a public or production deployment. To send real
messages:

1. Create a Twilio account; get an SMS-capable number.
2. For WhatsApp, join the **WhatsApp Sandbox** (Messaging → Try it out) from
   each phone that should receive codes.

```bash
supabase secrets set \
  OTP_PROVIDER=twilio \
  TWILIO_ACCOUNT_SID=AC… \
  TWILIO_AUTH_TOKEN=… \
  TWILIO_SMS_FROM=+1… \
  TWILIO_WHATSAPP_FROM=+14155238886 \
  --project-ref <PROJECT_REF>
```

Trial-account caveat: SMS goes only to verified numbers; WhatsApp only to
sandbox-joined numbers.

## 4. n8n (outbox delivery)

1. Import `n8n/restamenu-outbox.json`.
2. Webhook node → create a Header Auth credential: name `Authorization`,
   value = a **random secret** (generate one; never a database key).
3. Telegram node → your credential + chat id. Activate the workflow.
4. Store both in Vault:

```sql
select vault.create_secret('https://<n8n-host>/webhook/restamenu-outbox', 'n8n_outbox_webhook_url');
select vault.create_secret('<the same random secret>', 'n8n_outbox_auth');
```

5. Verify: approve a PO → within a minute `process_outbox()` posts the event
   and `reconcile_outbox()` marks it delivered — watch the Audit page's
   outbox table move `pending → delivering → delivered`, and the Telegram
   message arrive. Deactivating the workflow and approving another PO shows
   the retry/backoff path instead.

## 5. Deploy notes

- Functions: `supabase functions deploy <name> --project-ref <REF> --use-api`
  (config.toml pins per-function `verify_jwt`).
- Web: push to main → Vercel builds. No new environment variables needed.
- Migrations `014–022` must be applied before the new pages load
  (`supabase/migrations/` is the source of truth).
