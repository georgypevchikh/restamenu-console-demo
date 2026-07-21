/**
 * Pure Xero API building blocks: URL/payload builders and response parsers.
 * No fetch, no secrets, no runtime APIs — the xero-* Edge Functions own the
 * network; this file owns the shapes, so both sides stay unit-testable.
 *
 * Endpoints (OAuth 2.0 authorization-code flow, demo company):
 *   authorize:   https://login.xero.com/identity/connect/authorize
 *   token:       https://identity.xero.com/connect/token   (Basic auth, rotates refresh token)
 *   connections: https://api.xero.com/connections           (tenant discovery)
 *   invoices:    https://api.xero.com/api.xro/2.0/Invoices  (xero-tenant-id header)
 */

import { minorToMajorString } from "./money.ts";

export const XERO_AUTHORIZE_URL =
  "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_INVOICES_URL = "https://api.xero.com/api.xro/2.0/Invoices";
export const XERO_CONTACTS_URL = "https://api.xero.com/api.xro/2.0/Contacts";

// Xero replaced the broad `accounting.transactions` scope with granular scopes
// for apps created after 2 March 2026. `accounting.invoices` covers the ACCPAY
// bill push/import; `accounting.contacts` covers supplier contact resolution.
export const XERO_SCOPES =
  "offline_access openid profile email accounting.invoices accounting.contacts";

const DEFAULT_APP_REDIRECT = "/dashboard/settings/xero";
const XERO_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept only an absolute path on the current application origin.
 *
 * `startsWith("/")` is not enough: `//attacker.example` and `/\\attacker.example`
 * are network-path references under the URL standard and can escape the app
 * origin. Resolving against a fixed sentinel origin gives us one canonical
 * check and also protects callbacks that contain an older, unsafe state row.
 */
export function sanitizeInternalPath(
  value: unknown,
  fallback = DEFAULT_APP_REDIRECT,
): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;

  try {
    const sentinel = new URL("https://restamenu.invalid");
    const resolved = new URL(value, sentinel);
    if (resolved.origin !== sentinel.origin) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

/** Build a browser redirect without allowing the stored path to change origin. */
export function buildAppRedirectUrl(
  appBase: string,
  path: unknown,
  params: Record<string, string>,
  fallback = DEFAULT_APP_REDIRECT,
): string {
  const base = new URL(appBase);
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new XeroResponseError(
      "bad_app_base",
      "APP_BASE_URL must be an HTTPS origin without a path, query, or fragment",
    );
  }

  const url = new URL(sanitizeInternalPath(path, fallback), base.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
  });
  // Xero's identity server rejects '+'-encoded spaces in `scope` with
  // invalid_scope; it requires %20. URLSearchParams encodes spaces as '+', so
  // append scope separately with encodeURIComponent (which emits %20).
  const scope = params.scopes ?? XERO_SCOPES;
  return `${XERO_AUTHORIZE_URL}?${q.toString()}&scope=${encodeURIComponent(scope)}`;
}

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

export class XeroResponseError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "XeroResponseError";
  }
}

/**
 * Run one authenticated request and, only on 401, refresh once and retry once.
 * A second 401 is returned to the caller; this helper never loops.
 */
export async function withOne401Retry<TToken, TResponse>(params: {
  token: TToken;
  request: (token: TToken) => Promise<TResponse>;
  refresh: (token: TToken) => Promise<TToken>;
  status: (response: TResponse) => number;
}): Promise<{ token: TToken; response: TResponse; retried: boolean }> {
  let token = params.token;
  let response = await params.request(token);
  if (params.status(response) !== 401) {
    return { token, response, retried: false };
  }

  token = await params.refresh(token);
  response = await params.request(token);
  return { token, response, retried: true };
}

/**
 * A failed refresh can be a stale loser after another worker rotated the
 * refresh token. Expire only if compare-and-set says the failed token is
 * still current; otherwise re-read and continue with the winner's token.
 */
export async function resolveRefreshFailure<TCurrent>(params: {
  markExpiredIfCurrent: () => Promise<boolean>;
  readCurrent: () => Promise<TCurrent | null>;
}): Promise<
  | { kind: "expired" }
  | { kind: "superseded"; current: TCurrent }
> {
  if (await params.markExpiredIfCurrent()) return { kind: "expired" };
  const current = await params.readCurrent();
  if (current === null) {
    throw new XeroResponseError(
      "refresh_recovery_failed",
      "refresh token changed but the winning token row could not be read",
    );
  }
  return { kind: "superseded", current };
}

export interface XeroRefreshFailureHttp {
  terminal: boolean;
  status: 409 | 503;
  code: "xero_connection_expired" | "xero_refresh_temporarily_unavailable";
}

/**
 * Only a compare-and-set-confirmed invalid_grant is terminal. Network errors,
 * Xero 5xx responses and local persistence/recovery failures are retryable and
 * must never tell the operator to reconnect a still-valid organisation.
 */
export function classifyRefreshFailure(
  reason: string,
): XeroRefreshFailureHttp {
  return reason === "refresh_grant_expired"
    ? { terminal: true, status: 409, code: "xero_connection_expired" }
    : {
      terminal: false,
      status: 503,
      code: "xero_refresh_temporarily_unavailable",
    };
}

export function parseTokenResponse(json: unknown, now: Date): XeroTokens {
  const o = json as Record<string, unknown>;
  const access = o?.["access_token"];
  const refresh = o?.["refresh_token"];
  const expiresIn = o?.["expires_in"];
  if (
    typeof access !== "string" || access.length === 0 ||
    typeof refresh !== "string" || refresh.length === 0 ||
    typeof expiresIn !== "number" || !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new XeroResponseError(
      "bad_token_response",
      "token response missing access_token/refresh_token/expires_in",
    );
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
  };
}

export interface XeroConnection {
  tenantId: string;
  tenantName: string;
}

export function parseConnections(json: unknown): XeroConnection[] {
  if (!Array.isArray(json)) {
    throw new XeroResponseError(
      "bad_connections_response",
      "connections response is not an array",
    );
  }
  return json
    .filter((c) =>
      c !== null && typeof c === "object" &&
      typeof (c as Record<string, unknown>)["tenantId"] === "string" &&
      XERO_GUID.test(
        (c as Record<string, unknown>)["tenantId"] as string,
      )
    )
    .map((c) => ({
      tenantId: c.tenantId as string,
      tenantName: typeof c.tenantName === "string" ? c.tenantName : "",
    }));
}

/** Access tokens live ~30 min; refresh when inside the skew window. */
export function needsRefresh(
  expiresAt: string | null,
  now: Date,
  skewSeconds = 120,
): boolean {
  if (!expiresAt) return true;
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs - now.getTime() < skewSeconds * 1000;
}

export interface PoForXero {
  po_number: string;
  supplier_name: string;
  currency: string;
  created_at: string; // ISO
  subtotal_minor: number;
  tax_total_minor: number;
  withholding_minor: number;
  total_minor: number;
  lines: Array<{
    description: string;
    quantity_milli: number;
    unit_price_minor: number;
    line_subtotal_minor: number;
  }>;
}

const XERO_SAFE_REFERENCE = /^[A-Za-z0-9:._-]{1,255}$/;

/**
 * The local PO number is only unique inside one restaurant. Prefix it with
 * the restaurant id before placing it in Xero so a second Restamenu tenant
 * connected to the same Xero organisation cannot collide during recovery.
 */
export function buildXeroReference(
  restaurantId: string,
  poNumber: string,
): string {
  const reference = `RM:${restaurantId}:${poNumber}`;
  if (!XERO_SAFE_REFERENCE.test(reference)) {
    throw new XeroResponseError(
      "bad_xero_reference",
      "generated Xero reference contains unsupported characters",
    );
  }
  return reference;
}

/** One canonical key for case/spacing variants of a supplier display name. */
export function normalizeSupplierKey(name: string): string {
  const normalized = name.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > 200) {
    throw new XeroResponseError(
      "bad_supplier_name",
      "supplier name must contain 1-200 normalized characters",
    );
  }
  return normalized;
}

/** Stable external-system identifier, without exposing the supplier name. */
export async function buildExternalContactNumber(
  restaurantId: string,
  supplierKey: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${restaurantId}:${supplierKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `RM:${hex.slice(0, 24)}`;
}

export function buildInvoiceLookupUrl(reference: string): string {
  if (!XERO_SAFE_REFERENCE.test(reference)) {
    throw new XeroResponseError("bad_xero_reference", "invalid Xero reference");
  }
  const url = new URL(XERO_INVOICES_URL);
  url.searchParams.set(
    "where",
    `Type==\"ACCPAY\" AND Reference==\"${reference}\"`,
  );
  return url.toString();
}

export function buildContactLookupUrl(supplierName: string): string {
  // searchTerm avoids interpolating user text into Xero's `where` grammar.
  // Responses are still filtered by exact normalized name below.
  const name = supplierName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 200) {
    throw new XeroResponseError("bad_supplier_name", "invalid supplier name");
  }
  const url = new URL(XERO_CONTACTS_URL);
  url.searchParams.set("searchTerm", name);
  url.searchParams.set("includeArchived", "false");
  return url.toString();
}

export function buildContactNumberLookupUrl(contactNumber: string): string {
  if (!/^RM:[0-9a-f]{24}$/.test(contactNumber)) {
    throw new XeroResponseError(
      "bad_contact_number",
      "invalid Restamenu ContactNumber",
    );
  }
  return `${XERO_CONTACTS_URL}/${encodeURIComponent(contactNumber)}`;
}

export function buildContactPayload(
  supplierName: string,
  contactNumber: string,
): {
  Contacts: Array<{ Name: string; ContactNumber: string }>;
} {
  const name = supplierName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  normalizeSupplierKey(name);
  buildContactNumberLookupUrl(contactNumber);
  return { Contacts: [{ Name: name, ContactNumber: contactNumber }] };
}

/**
 * An approved PO becomes a DRAFT ACCPAY invoice (a bill) in Xero. Amounts are
 * converted from minor units at this boundary only. The persisted ContactID
 * is mandatory; display names are not an identity boundary. AccountCode is
 * optional at this pure builder boundary so payload validation remains
 * independently testable. The deployed push path requires a verified
 * XERO_DEFAULT_ACCOUNT_CODE because every organisation has its own chart.
 */
export function buildBillPayload(
  po: PoForXero,
  xeroContactId: string,
  xeroReference: string,
  accountCode?: string,
): Record<string, unknown> {
  if (!XERO_GUID.test(xeroContactId)) {
    throw new XeroResponseError(
      "bad_contact_id",
      "a valid Xero ContactID is required",
    );
  }
  if (!XERO_SAFE_REFERENCE.test(xeroReference)) {
    throw new XeroResponseError("bad_xero_reference", "invalid Xero reference");
  }
  const date = po.created_at.slice(0, 10);
  const normalizedAccountCode = accountCode?.trim() || undefined;
  const amounts = [
    po.subtotal_minor,
    po.tax_total_minor,
    po.withholding_minor,
    po.total_minor,
    ...po.lines.map((line) => line.line_subtotal_minor),
  ];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new XeroResponseError(
      "bad_invoice_amounts",
      "invoice amounts must be non-negative safe integers",
    );
  }
  const lineSubtotal = po.lines.reduce(
    (sum, line) => sum + line.line_subtotal_minor,
    0,
  );
  const expectedTotal = po.subtotal_minor + po.tax_total_minor -
    po.withholding_minor;
  if (
    !Number.isSafeInteger(lineSubtotal) || lineSubtotal !== po.subtotal_minor ||
    !Number.isSafeInteger(expectedTotal) || expectedTotal !== po.total_minor
  ) {
    throw new XeroResponseError(
      "invoice_total_mismatch",
      "PO lines, tax, withholding, and total do not reconcile",
    );
  }
  const account = normalizedAccountCode
    ? { AccountCode: normalizedAccountCode }
    : {};
  const lineItems: Array<Record<string, unknown>> = po.lines.map((line) => ({
    Description: line.description,
    // Use exact persisted line totals at the accounting boundary. Original
    // quantity/unit-price detail remains in Restamenu's immutable PO trace.
    Quantity: 1,
    UnitAmount: Number(minorToMajorString(line.line_subtotal_minor)),
    ...account,
  }));
  if (po.tax_total_minor > 0) {
    lineItems.push({
      Description: "Tax total (Restamenu authoritative calculation)",
      Quantity: 1,
      UnitAmount: Number(minorToMajorString(po.tax_total_minor)),
      ...account,
    });
  }
  if (po.withholding_minor > 0) {
    lineItems.push({
      Description:
        "Withholding adjustment (Restamenu authoritative calculation)",
      Quantity: 1,
      UnitAmount: -Number(minorToMajorString(po.withholding_minor)),
      ...account,
    });
  }
  return {
    Invoices: [
      {
        Type: "ACCPAY",
        Contact: { ContactID: xeroContactId },
        Date: date,
        DueDate: date,
        Reference: xeroReference,
        Status: "DRAFT",
        CurrencyCode: po.currency,
        // Explicit adjustments already represent the authoritative tax trace;
        // asking Xero to calculate tax again would double-count or diverge.
        LineAmountTypes: "NoTax",
        LineItems: lineItems,
      },
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rejectXeroErrorEnvelope(root: Record<string, unknown>): void {
  const statusCode = root["StatusCode"];
  const type = root["Type"];
  if (
    root["ErrorNumber"] !== undefined ||
    (typeof statusCode === "number" && statusCode >= 400) ||
    (typeof type === "string" && /(?:Exception|Error)$/i.test(type))
  ) {
    throw new XeroResponseError(
      "xero_api_error",
      "Xero returned an API error envelope",
    );
  }
}

function uniqueGuids(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

/**
 * Parse an invoice-reconciliation query. Zero ids means no prior write; one
 * id is recoverable; more than one is deliberately returned so the caller can
 * stop for manual reconciliation instead of guessing.
 */
export function parseInvoiceIdsByReference(
  json: unknown,
  expectedReference: string,
): string[] {
  const root = asRecord(json);
  if (!root) {
    throw new XeroResponseError(
      "bad_invoices_response",
      "invoice lookup response is not an object",
    );
  }
  rejectXeroErrorEnvelope(root);
  const invoices = root["Invoices"];
  if (!Array.isArray(invoices)) {
    throw new XeroResponseError(
      "bad_invoices_response",
      "invoice lookup response missing Invoices array",
    );
  }

  const ids: string[] = [];
  for (const value of invoices) {
    const invoice = asRecord(value);
    if (!invoice) continue;
    if (
      invoice["Type"] !== "ACCPAY" ||
      invoice["Reference"] !== expectedReference
    ) continue;
    const id = invoice["InvoiceID"];
    if (typeof id !== "string" || !XERO_GUID.test(id)) {
      throw new XeroResponseError(
        "bad_invoices_response",
        "matching invoice is missing a valid InvoiceID",
      );
    }
    ids.push(id);
  }
  return uniqueGuids(ids);
}

/** Return exact-name ContactIDs from a search response; never fuzzy-match. */
export function parseContactIdsByName(
  json: unknown,
  expectedName: string,
): string[] {
  const root = asRecord(json);
  if (!root) {
    throw new XeroResponseError(
      "bad_contacts_response",
      "contact lookup response is not an object",
    );
  }
  rejectXeroErrorEnvelope(root);
  const contacts = root["Contacts"];
  if (!Array.isArray(contacts)) {
    throw new XeroResponseError(
      "bad_contacts_response",
      "contact lookup response missing Contacts array",
    );
  }

  const expectedKey = normalizeSupplierKey(expectedName);
  const ids: string[] = [];
  for (const value of contacts) {
    const contact = asRecord(value);
    if (!contact || typeof contact["Name"] !== "string") continue;
    let contactKey: string;
    try {
      contactKey = normalizeSupplierKey(contact["Name"]);
    } catch {
      continue;
    }
    if (contactKey !== expectedKey) continue;
    const id = contact["ContactID"];
    if (typeof id !== "string" || !XERO_GUID.test(id)) {
      throw new XeroResponseError(
        "bad_contacts_response",
        "matching contact is missing a valid ContactID",
      );
    }
    ids.push(id);
  }
  return uniqueGuids(ids);
}

export function parseContactIdsByNumber(
  json: unknown,
  expectedContactNumber: string,
): string[] {
  buildContactNumberLookupUrl(expectedContactNumber);
  const root = asRecord(json);
  if (!root) {
    throw new XeroResponseError(
      "bad_contacts_response",
      "contact lookup response is not an object",
    );
  }
  rejectXeroErrorEnvelope(root);
  const contacts = root["Contacts"];
  if (!Array.isArray(contacts)) {
    throw new XeroResponseError(
      "bad_contacts_response",
      "contact lookup response missing Contacts array",
    );
  }
  const ids: string[] = [];
  let returnedContacts = 0;
  let mismatchedContacts = 0;
  for (const value of contacts) {
    const contact = asRecord(value);
    if (!contact) continue;
    returnedContacts += 1;
    if (contact["ContactNumber"] !== expectedContactNumber) {
      mismatchedContacts += 1;
      continue;
    }
    const id = contact["ContactID"];
    if (typeof id !== "string" || !XERO_GUID.test(id)) {
      throw new XeroResponseError(
        "bad_contacts_response",
        "matching contact is missing a valid ContactID",
      );
    }
    ids.push(id);
  }
  if (mismatchedContacts > 0 || (returnedContacts > 0 && ids.length === 0)) {
    throw new XeroResponseError(
      "contact_number_mismatch",
      "Xero returned a contact that did not echo the requested ContactNumber",
    );
  }
  return uniqueGuids(ids);
}

export function parseCreatedContactId(json: unknown): string {
  const root = asRecord(json);
  if (!root) {
    throw new XeroResponseError(
      "bad_contact_response",
      "contact response is not an object",
    );
  }
  rejectXeroErrorEnvelope(root);
  const contacts = root["Contacts"];
  if (!Array.isArray(contacts) || contacts.length !== 1) {
    throw new XeroResponseError(
      "bad_contact_response",
      "create contact response must contain exactly one contact",
    );
  }
  const contact = asRecord(contacts[0]);
  if (!contact || contact["HasErrors"] === true) {
    throw new XeroResponseError(
      "contact_validation_failed",
      "Xero rejected the contact payload",
    );
  }
  const id = contact["ContactID"];
  if (typeof id !== "string" || !XERO_GUID.test(id)) {
    throw new XeroResponseError(
      "bad_contact_response",
      "create contact response is missing a valid ContactID",
    );
  }
  return id;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Single, injectable HTTP boundary used by the Edge Function. Unit tests can
 * assert URL/header/body contracts without contacting Xero.
 */
export function requestXero(
  fetcher: FetchLike,
  params: {
    url: string;
    accessToken: string;
    tenantId: string;
    method?: "GET" | "POST";
    idempotencyKey?: string;
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.accessToken}`,
    "xero-tenant-id": params.tenantId,
    Accept: "application/json",
  };
  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }
  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return fetcher(params.url, {
    method: params.method ?? "GET",
    headers,
    signal: params.signal,
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
  });
}

/**
 * A successful create-invoice response is not usable until Xero returns the
 * durable InvoiceID. Xero can also return validation failures inside a 200
 * response, so both conditions are treated as a failed/ambiguous push.
 */
export function parseCreatedInvoiceId(json: unknown): string {
  const root = asRecord(json);
  if (!root) {
    throw new XeroResponseError(
      "bad_invoice_response",
      "invoice response is not an object",
    );
  }
  rejectXeroErrorEnvelope(root);

  const invoices = root["Invoices"];
  if (!Array.isArray(invoices) || invoices.length !== 1) {
    throw new XeroResponseError(
      "bad_invoice_response",
      "create invoice response must contain exactly one invoice",
    );
  }

  const invoice = invoices[0] as Record<string, unknown> | null;
  if (!invoice || invoice["HasErrors"] === true) {
    throw new XeroResponseError(
      "invoice_validation_failed",
      "Xero rejected the invoice payload",
    );
  }

  const invoiceId = invoice["InvoiceID"];
  if (typeof invoiceId !== "string" || !XERO_GUID.test(invoiceId)) {
    throw new XeroResponseError(
      "bad_invoice_response",
      "create invoice response is missing a valid InvoiceID",
    );
  }
  return invoiceId;
}

function xeroMajorToMinor(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new XeroResponseError(
      "bad_invoice_total",
      `${context} is missing a numeric Total`,
    );
  }
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    throw new XeroResponseError(
      "bad_invoice_total",
      `${context} Total cannot be represented in integer minor units`,
    );
  }
  return rounded;
}

export interface ReconciledInvoice {
  invoiceId: string;
  totalMinor: number;
}

/** A successful create is accepted only with both durable ID and exact total. */
export function parseCreatedInvoiceResult(json: unknown): ReconciledInvoice {
  const invoiceId = parseCreatedInvoiceId(json);
  const root = asRecord(json);
  const invoice = root && Array.isArray(root["Invoices"])
    ? asRecord(root["Invoices"][0])
    : null;
  return {
    invoiceId,
    totalMinor: xeroMajorToMinor(invoice?.["Total"], "created invoice"),
  };
}

export function parseInvoiceMatchesByReference(
  json: unknown,
  expectedReference: string,
): ReconciledInvoice[] {
  const ids = parseInvoiceIdsByReference(json, expectedReference);
  const root = asRecord(json)!;
  const invoices = root["Invoices"] as unknown[];
  const byId = new Map<string, number>();
  for (const value of invoices) {
    const invoice = asRecord(value);
    if (
      !invoice || invoice["Type"] !== "ACCPAY" ||
      invoice["Reference"] !== expectedReference ||
      typeof invoice["InvoiceID"] !== "string"
    ) continue;
    const id = invoice["InvoiceID"].toLowerCase();
    const total = xeroMajorToMinor(invoice["Total"], "reconciled invoice");
    const prior = byId.get(id);
    if (prior !== undefined && prior !== total) {
      throw new XeroResponseError(
        "bad_invoice_total",
        "duplicate InvoiceID rows disagree on Total",
      );
    }
    byId.set(id, total);
  }
  return ids.map((invoiceId) => ({
    invoiceId,
    totalMinor: byId.get(invoiceId)!,
  }));
}

export interface ImportedBill {
  xeroInvoiceId: string;
  contactName: string | null;
  status: string | null;
  date: string | null;
  dueDate: string | null;
  total: number | null;
  currency: string | null;
  raw: Record<string, unknown>;
}

/** Xero serialises dates as /Date(ms+offset)/ in JSON responses. */
export function parseXeroDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (iso) return value.slice(0, 10);
  const ms = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(value);
  if (ms) {
    const timestamp = Number(ms[1]);
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  return null;
}

export interface ImportedBillPage {
  bills: ImportedBill[];
  responseCount: number;
}

/** Parse one Xero page while preserving the raw row count for pagination. */
export function parseBillPage(json: unknown): ImportedBillPage {
  const root = asRecord(json);
  if (!root) {
    throw new XeroResponseError(
      "bad_invoices_response",
      "invoices response is not an object",
    );
  }
  rejectXeroErrorEnvelope(root);

  const invoices = root["Invoices"];
  if (!Array.isArray(invoices)) {
    throw new XeroResponseError(
      "bad_invoices_response",
      "invoices response missing Invoices array",
    );
  }
  const bills: ImportedBill[] = [];
  for (const value of invoices) {
    const invoice = asRecord(value);
    if (!invoice || invoice["Type"] !== "ACCPAY") continue;

    const invoiceId = invoice["InvoiceID"];
    if (typeof invoiceId !== "string" || !XERO_GUID.test(invoiceId)) {
      throw new XeroResponseError(
        "bad_invoices_response",
        "ACCPAY invoice is missing a valid InvoiceID",
      );
    }

    const contact = asRecord(invoice["Contact"]);
    const total = invoice["Total"];
    bills.push({
      xeroInvoiceId: invoiceId,
      contactName: typeof contact?.["Name"] === "string"
        ? contact["Name"]
        : null,
      status: typeof invoice["Status"] === "string" ? invoice["Status"] : null,
      date: parseXeroDate(invoice["DateString"] ?? invoice["Date"]),
      dueDate: parseXeroDate(invoice["DueDateString"] ?? invoice["DueDate"]),
      total: typeof total === "number" && Number.isFinite(total) ? total : null,
      currency: typeof invoice["CurrencyCode"] === "string"
        ? invoice["CurrencyCode"]
        : null,
      raw: invoice,
    });
  }
  return { bills, responseCount: invoices.length };
}

export function parseBills(json: unknown): ImportedBill[] {
  return parseBillPage(json).bills;
}
