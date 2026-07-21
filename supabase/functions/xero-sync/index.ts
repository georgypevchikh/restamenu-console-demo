/**
 * POST { action: "push_invoice", poId } | { action: "import_bills" }
 *
 * The working end of the Xero integration. Manager-only, entitlement-gated.
 *
 * Token lifecycle: tokens come out of encrypted storage via get_xero_tokens;
 * when the access token is inside the refresh window the function refreshes
 * it first. Xero rotates the refresh token on every refresh, so the update is
 * a compare-and-swap (update_xero_tokens_if_current) — a concurrent refresh
 * that lost the race re-reads instead of clobbering the newer pair. A failed
 * refresh (revoked/expired grant) marks the connection and returns 409.
 * Any Accounting API request that still returns 401 refreshes once and is
 * retried exactly once; a second 401 is returned without another loop.
 *
 * push_invoice: an APPROVED purchase order becomes a DRAFT ACCPAY bill.
 * The PO is read through the caller's JWT — RLS proves tenant ownership. A
 * durable database claim serializes callers. Supplier names resolve to a
 * persisted Xero ContactID before invoice creation. Because Xero only retains
 * idempotency keys briefly, every retry reconciles exact Contact/Reference
 * identities before a fresh POST; completion stamps the PO + journal + audit
 * + outbox in one transaction.
 * import_bills: pulls ACCPAY invoices into the xero_bills mirror (upsert on
 * xero_invoice_id). Every operation — success or error — lands in
 * xero_sync_log; pushes also stamp the PO and write audit + outbox rows.
 */

import { resolveCaller, serviceClient, userClient } from "../_shared/db.ts";
import { errorJson, internalError, json } from "../_shared/http.ts";
import {
  buildBillPayload,
  buildContactLookupUrl,
  buildContactNumberLookupUrl,
  buildContactPayload,
  buildExternalContactNumber,
  buildInvoiceLookupUrl,
  buildXeroReference,
  classifyRefreshFailure,
  needsRefresh,
  normalizeSupplierKey,
  parseBillPage,
  parseContactIdsByName,
  parseContactIdsByNumber,
  parseCreatedContactId,
  parseCreatedInvoiceResult,
  parseInvoiceMatchesByReference,
  parseTokenResponse,
  type PoForXero,
  requestXero,
  resolveRefreshFailure,
  withOne401Retry,
  XERO_CONTACTS_URL,
  XERO_INVOICES_URL,
  XERO_TOKEN_URL,
  XeroResponseError,
} from "../_shared/core/xero-core.ts";

interface Tokens {
  access_token: string;
  refresh_token: string;
  access_expires_at: string | null;
  xero_tenant_id: string;
  status: string;
}

const XERO_REQUEST_TIMEOUT_MS = 20_000;
const XERO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasUsableTokenMaterial(tokens: Tokens): boolean {
  return tokens.status === "connected" &&
    typeof tokens.access_token === "string" && tokens.access_token.length > 0 &&
    typeof tokens.refresh_token === "string" &&
    tokens.refresh_token.length > 0 &&
    typeof tokens.xero_tenant_id === "string" &&
    XERO_ID_PATTERN.test(tokens.xero_tenant_id);
}

interface PushClaim {
  state: "claimed" | "busy" | "succeeded";
  external_reference?: string;
  claim_token?: string;
  xero_invoice_id?: string;
  needs_reconciliation?: boolean;
  retry_after_seconds?: number;
}

interface ContactClaim {
  state: "claimed" | "busy" | "resolved";
  claim_token?: string;
  xero_contact_id?: string;
  external_contact_number?: string;
  needs_reconciliation?: boolean;
  retry_after_seconds?: number;
}

interface PostAttempt {
  idempotency_key: string;
  reused: boolean;
  valid_until: string;
}

class XeroTokenRefreshFailure extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "XeroTokenRefreshFailure";
  }
}

function refreshFailureResponse(reason: string): Response {
  const failure = classifyRefreshFailure(reason);
  return errorJson(failure.status, failure.code, reason);
}

async function refreshTokens(
  db: ReturnType<typeof serviceClient>,
  restaurantId: string,
  current: Tokens,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: true; tokens: Tokens } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(XERO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[xero-sync] refresh network", error);
    return { ok: false, reason: "refresh_transient_failure" };
  }

  const bodyJson = await res.json().catch(() => null);

  if (!res.ok || !bodyJson) {
    const oauthError = bodyJson !== null && typeof bodyJson === "object"
      ? (bodyJson as Record<string, unknown>)["error"]
      : null;
    let recovered: Tokens | null = null;
    let failureReason = "refresh_transient_failure";

    // Only invalid_grant proves this refresh token is terminal, and even then
    // a concurrent winner may already have rotated storage to a newer token.
    if (oauthError === "invalid_grant") {
      try {
        const resolution = await resolveRefreshFailure<Tokens>({
          markExpiredIfCurrent: async () => {
            const { data: marked, error: markError } = await db.rpc(
              "mark_xero_connection_if_current",
              {
                p_restaurant_id: restaurantId,
                p_old_refresh: current.refresh_token,
                p_status: "expired",
              },
            );
            if (markError) throw markError;
            return marked === true;
          },
          readCurrent: async () => {
            const { data, error: readError } = await db.rpc("get_xero_tokens", {
              p_restaurant_id: restaurantId,
            });
            if (readError) throw readError;
            return (data as Tokens[] | null)?.[0] ?? null;
          },
        });
        if (
          resolution.kind === "superseded" &&
          resolution.current.status === "connected"
        ) {
          recovered = resolution.current;
        } else if (
          resolution.kind === "expired" ||
          (resolution.kind === "superseded" &&
            (resolution.current.status === "expired" ||
              resolution.current.status === "revoked"))
        ) {
          failureReason = "refresh_grant_expired";
        } else {
          failureReason = "refresh_recovery_failed";
        }
      } catch (recoveryError) {
        console.error("[xero-sync] refresh failure recovery", recoveryError);
        return { ok: false, reason: "refresh_recovery_failed" };
      }
    }

    if (recovered) return { ok: true, tokens: recovered };
    const { error: logError } = await db.from("xero_sync_log").insert({
      restaurant_id: restaurantId,
      operation: "token_refresh",
      direction: "auth",
      status: "error",
      error: `refresh failed: HTTP ${res.status}`,
    });
    if (logError) console.error("[xero-sync] refresh error log", logError);
    return {
      ok: false,
      reason: failureReason,
    };
  }

  const parsed = parseTokenResponse(bodyJson, new Date());

  const { data: applied, error: updateError } = await db.rpc(
    "update_xero_tokens_if_current",
    {
      p_restaurant_id: restaurantId,
      p_old_refresh: current.refresh_token,
      p_new_access: parsed.accessToken,
      p_new_refresh: parsed.refreshToken,
      p_expires_at: parsed.expiresAt,
    },
  );
  if (updateError) {
    console.error("[xero-sync] token CAS", updateError);
    return { ok: false, reason: "token_store_failed" };
  }

  if (applied === false) {
    // Another instance refreshed first — its pair is newer; use the stored one.
    const { data, error: readError } = await db.rpc("get_xero_tokens", {
      p_restaurant_id: restaurantId,
    });
    if (readError) {
      console.error("[xero-sync] token CAS reread", readError);
      return { ok: false, reason: "token_reread_failed" };
    }
    const row = (data as Tokens[] | null)?.[0];
    if (!row) return { ok: false, reason: "connection_lost" };
    if (row.status === "expired" || row.status === "revoked") {
      return { ok: false, reason: "refresh_grant_expired" };
    }
    if (!hasUsableTokenMaterial(row)) {
      return { ok: false, reason: "token_material_invalid" };
    }
    return { ok: true, tokens: row };
  }

  const { error: logError } = await db.from("xero_sync_log").insert({
    restaurant_id: restaurantId,
    operation: "token_refresh",
    direction: "auth",
    status: "success",
  });
  if (logError) console.error("[xero-sync] refresh success log", logError);

  return {
    ok: true,
    tokens: {
      ...current,
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
      access_expires_at: parsed.expiresAt,
    },
  };
}

async function requestWithOneRefresh(
  db: ReturnType<typeof serviceClient>,
  restaurantId: string,
  tokens: Tokens,
  clientId: string,
  clientSecret: string,
  request: (tokens: Tokens) => Promise<Response>,
): Promise<{ tokens: Tokens; response: Response; retried: boolean }> {
  const result = await withOne401Retry({
    token: tokens,
    request,
    status: (response) => response.status,
    refresh: async (current) => {
      const refreshed = await refreshTokens(
        db,
        restaurantId,
        current,
        clientId,
        clientSecret,
      );
      if (!refreshed.ok) throw new XeroTokenRefreshFailure(refreshed.reason);
      if (!hasUsableTokenMaterial(refreshed.tokens)) {
        throw new XeroTokenRefreshFailure("token_material_invalid");
      }
      return refreshed.tokens;
    },
  });
  return {
    tokens: result.token,
    response: result.response,
    retried: result.retried,
  };
}

async function releasePushClaim(
  db: ReturnType<typeof serviceClient>,
  restaurantId: string,
  poId: string,
  claimToken: string,
  error: string,
  ambiguous: boolean,
): Promise<void> {
  const { error: releaseError } = await db.rpc("release_xero_invoice_push", {
    p_restaurant_id: restaurantId,
    p_po_id: poId,
    p_claim_token: claimToken,
    p_error: error,
    p_ambiguous: ambiguous,
  });
  if (releaseError) console.error("[xero-sync] push release", releaseError);
}

async function releaseContactClaim(
  db: ReturnType<typeof serviceClient>,
  restaurantId: string,
  supplierKey: string,
  claimToken: string,
  error: string,
  ambiguous: boolean,
): Promise<void> {
  const { error: releaseError } = await db.rpc(
    "release_xero_contact_resolution",
    {
      p_restaurant_id: restaurantId,
      p_supplier_key: supplierKey,
      p_claim_token: claimToken,
      p_error: error,
      p_ambiguous: ambiguous,
    },
  );
  if (releaseError) console.error("[xero-sync] contact release", releaseError);
}

async function logPushError(
  db: ReturnType<typeof serviceClient>,
  restaurantId: string,
  poNumber: string,
  error: string,
): Promise<void> {
  const { error: logError } = await db.from("xero_sync_log").insert({
    restaurant_id: restaurantId,
    operation: "invoice_push",
    direction: "push",
    status: "error",
    error,
    summary: { po_number: poNumber },
  });
  if (logError) console.error("[xero-sync] push error log", logError);
}

interface PushPo {
  po_number: string;
  supplier_name: string;
  currency: string;
  created_at: string;
  subtotal_minor: number;
  tax_total_minor: number;
  withholding_minor: number;
  total_minor: number;
}

interface PushLine {
  description: string;
  quantity: number | string;
  unit_price_minor: number;
  line_subtotal_minor: number;
}

interface PushContext {
  db: ReturnType<typeof serviceClient>;
  restaurantId: string;
  actorId: string;
  clientId: string;
  clientSecret: string;
  accountCode: string;
}

async function accountingRequest(
  context: PushContext,
  tokens: Tokens,
  params: {
    url: string;
    method?: "GET" | "POST";
    idempotencyKey?: string;
    body?: unknown;
  },
): Promise<{ tokens: Tokens; response: Response; body: unknown }> {
  const result = await requestWithOneRefresh(
    context.db,
    context.restaurantId,
    tokens,
    context.clientId,
    context.clientSecret,
    (current) =>
      requestXero(fetch, {
        ...params,
        accessToken: current.access_token,
        tenantId: current.xero_tenant_id,
        signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
      }),
  );
  return {
    tokens: result.tokens,
    response: result.response,
    body: await result.response.json().catch(() => null),
  };
}

function networkReason(prefix: string, error: unknown): string {
  if (error instanceof XeroTokenRefreshFailure) {
    return `token refresh failed: ${error.reason}`;
  }
  return error instanceof Error
    ? `${prefix} network error: ${error.message}`
    : `${prefix} network error`;
}

function xeroFailure(
  error: unknown,
  fallback: string,
): string {
  return error instanceof XeroResponseError
    ? `${error.code}: ${error.message}`
    : fallback;
}

interface ContactResolutionSuccess {
  ok: true;
  tokens: Tokens;
  contactId: string;
}

interface ContactResolutionFailure {
  ok: false;
  tokens: Tokens;
  response: Response;
  reason: string;
}

async function resolveSupplierContact(
  context: PushContext,
  tokens: Tokens,
  supplierName: string,
): Promise<ContactResolutionSuccess | ContactResolutionFailure> {
  const supplierKey = normalizeSupplierKey(supplierName);
  const expectedContactNumber = await buildExternalContactNumber(
    context.restaurantId,
    supplierKey,
  );
  const { data, error } = await context.db.rpc(
    "claim_xero_contact_resolution",
    {
      p_restaurant_id: context.restaurantId,
      p_supplier_key: supplierKey,
      p_supplier_name: supplierName,
    },
  );
  if (error) {
    return {
      ok: false,
      tokens,
      reason: "contact claim failed",
      response: internalError("xero-sync", error),
    };
  }
  const claim = data as ContactClaim | null;
  if (
    !claim?.external_contact_number ||
    claim.external_contact_number !== expectedContactNumber
  ) {
    if (claim?.state === "claimed" && claim.claim_token) {
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        "contact identity mismatch",
        false,
      );
    }
    return {
      ok: false,
      tokens,
      reason: "contact identity mismatch",
      response: internalError(
        "xero-sync",
        new Error("invalid Xero contact identity"),
      ),
    };
  }
  if (claim.state === "resolved" && claim.xero_contact_id) {
    return { ok: true, tokens, contactId: claim.xero_contact_id };
  }
  if (claim.state === "busy") {
    return {
      ok: false,
      tokens,
      reason: "supplier contact resolution is in progress",
      response: json(409, {
        error: "xero_contact_resolution_in_progress",
        retry_after_seconds: claim.retry_after_seconds ?? 5,
      }),
    };
  }
  if (claim.state !== "claimed" || !claim.claim_token) {
    return {
      ok: false,
      tokens,
      reason: "invalid contact claim response",
      response: internalError(
        "xero-sync",
        new Error("invalid Xero contact claim response"),
      ),
    };
  }

  let ids: string[] = [];
  let numberLookup: Awaited<ReturnType<typeof accountingRequest>>;
  try {
    numberLookup = await accountingRequest(context, tokens, {
      url: buildContactNumberLookupUrl(expectedContactNumber),
    });
    tokens = numberLookup.tokens;
  } catch (error) {
    const reason = networkReason("contact-number lookup", error);
    await releaseContactClaim(
      context.db,
      context.restaurantId,
      supplierKey,
      claim.claim_token,
      reason,
      claim.needs_reconciliation === true,
    );
    return {
      ok: false,
      tokens,
      reason,
      response: error instanceof XeroTokenRefreshFailure
        ? refreshFailureResponse(error.reason)
        : errorJson(502, "xero_contact_lookup_failed", reason),
    };
  }
  if (numberLookup.response.status !== 404) {
    if (!numberLookup.response.ok || !numberLookup.body) {
      const reason =
        `contact-number lookup HTTP ${numberLookup.response.status}`;
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        claim.needs_reconciliation === true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(502, "xero_contact_lookup_failed", reason),
      };
    }
    try {
      ids = parseContactIdsByNumber(
        numberLookup.body,
        expectedContactNumber,
      );
    } catch (error) {
      const reason = xeroFailure(error, "bad_contact_number_lookup_response");
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        claim.needs_reconciliation === true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(
          502,
          "xero_contact_lookup_invalid_response",
          reason,
        ),
      };
    }
  }
  if (ids.length > 1) {
    const reason = "multiple Xero contacts share the Restamenu ContactNumber";
    await releaseContactClaim(
      context.db,
      context.restaurantId,
      supplierKey,
      claim.claim_token,
      reason,
      true,
    );
    return {
      ok: false,
      tokens,
      reason,
      response: errorJson(409, "xero_contact_ambiguous", reason),
    };
  }

  // Adopt one legacy exact-name Contact if no Restamenu ContactNumber exists.
  if (ids.length === 0) {
    let nameLookup: Awaited<ReturnType<typeof accountingRequest>>;
    try {
      nameLookup = await accountingRequest(context, tokens, {
        url: buildContactLookupUrl(supplierName),
      });
      tokens = nameLookup.tokens;
    } catch (error) {
      const reason = networkReason("contact-name lookup", error);
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        claim.needs_reconciliation === true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: error instanceof XeroTokenRefreshFailure
          ? refreshFailureResponse(error.reason)
          : errorJson(502, "xero_contact_lookup_failed", reason),
      };
    }
    if (!nameLookup.response.ok || !nameLookup.body) {
      const reason = `contact-name lookup HTTP ${nameLookup.response.status}`;
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        claim.needs_reconciliation === true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(502, "xero_contact_lookup_failed", reason),
      };
    }
    try {
      ids = parseContactIdsByName(nameLookup.body, supplierName);
    } catch (error) {
      const reason = xeroFailure(error, "bad_contact_name_lookup_response");
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        claim.needs_reconciliation === true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(
          502,
          "xero_contact_lookup_invalid_response",
          reason,
        ),
      };
    }
    if (ids.length > 1) {
      const reason = "multiple Xero contacts have the exact supplier name";
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(409, "xero_contact_ambiguous", reason),
      };
    }
  }
  let contactId = ids[0];
  if (!contactId) {
    const { data: attemptData, error: attemptError } = await context.db.rpc(
      "begin_xero_contact_post_attempt",
      {
        p_restaurant_id: context.restaurantId,
        p_supplier_key: supplierKey,
        p_claim_token: claim.claim_token,
      },
    );
    if (attemptError) {
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        "contact attempt allocation failed",
        claim.needs_reconciliation === true,
      );
      return {
        ok: false,
        tokens,
        reason: "contact attempt allocation failed",
        response: internalError("xero-sync", attemptError),
      };
    }
    const attempt = attemptData as PostAttempt | null;
    if (!attempt?.idempotency_key) {
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        "invalid contact attempt response",
        true,
      );
      return {
        ok: false,
        tokens,
        reason: "invalid contact attempt response",
        response: internalError(
          "xero-sync",
          new Error("invalid Xero contact attempt response"),
        ),
      };
    }

    let created: Awaited<ReturnType<typeof accountingRequest>>;
    try {
      created = await accountingRequest(context, tokens, {
        url: XERO_CONTACTS_URL,
        method: "POST",
        idempotencyKey: attempt.idempotency_key,
        body: buildContactPayload(supplierName, expectedContactNumber),
      });
      tokens = created.tokens;
    } catch (error) {
      const reason = networkReason("contact create", error);
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: error instanceof XeroTokenRefreshFailure
          ? refreshFailureResponse(error.reason)
          : errorJson(502, "xero_contact_create_failed", reason),
      };
    }
    if (!created.response.ok || !created.body) {
      const reason = `contact create HTTP ${created.response.status}`;
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(502, "xero_contact_create_failed", reason),
      };
    }
    try {
      contactId = parseCreatedContactId(created.body);
    } catch (error) {
      const reason = xeroFailure(error, "bad_contact_create_response");
      await releaseContactClaim(
        context.db,
        context.restaurantId,
        supplierKey,
        claim.claim_token,
        reason,
        true,
      );
      return {
        ok: false,
        tokens,
        reason,
        response: errorJson(
          502,
          "xero_contact_create_invalid_response",
          reason,
        ),
      };
    }
  }

  const { data: contactCompleted, error: completeError } = await context.db.rpc(
    "complete_xero_contact_resolution",
    {
      p_restaurant_id: context.restaurantId,
      p_supplier_key: supplierKey,
      p_claim_token: claim.claim_token,
      p_xero_contact_id: contactId,
    },
  );
  if (completeError) {
    await releaseContactClaim(
      context.db,
      context.restaurantId,
      supplierKey,
      claim.claim_token,
      "contact mapping finalize failed",
      true,
    );
    return {
      ok: false,
      tokens,
      reason: "contact mapping finalize failed",
      response: internalError("xero-sync", completeError),
    };
  }
  if (contactCompleted !== true) {
    await releaseContactClaim(
      context.db,
      context.restaurantId,
      supplierKey,
      claim.claim_token,
      "contact mapping finalize returned no completion",
      true,
    );
    return {
      ok: false,
      tokens,
      reason: "contact mapping finalize returned no completion",
      response: internalError(
        "xero-sync",
        new Error("invalid Xero contact completion response"),
      ),
    };
  }
  return { ok: true, tokens, contactId };
}

async function executeInvoicePush(params: {
  context: PushContext;
  tokens: Tokens;
  poId: string;
  po: PushPo;
  lines: PushLine[];
}): Promise<Response> {
  const { context, poId, po, lines } = params;
  let tokens = params.tokens;
  const { data, error } = await context.db.rpc("claim_xero_invoice_push", {
    p_restaurant_id: context.restaurantId,
    p_po_id: poId,
  });
  if (error) return internalError("xero-sync", error);
  const claim = data as PushClaim | null;
  if (claim?.state === "busy") {
    return json(409, {
      error: "xero_push_in_progress",
      retry_after_seconds: claim.retry_after_seconds ?? 5,
    });
  }
  if (claim?.state === "succeeded") {
    return json(200, {
      pushed: false,
      alreadyPushed: true,
      xeroInvoiceId: claim.xero_invoice_id,
    });
  }
  if (
    claim?.state !== "claimed" || !claim.claim_token ||
    !claim.external_reference
  ) {
    return internalError(
      "xero-sync",
      new Error("invalid Xero push claim response"),
    );
  }
  const expectedReference = buildXeroReference(
    context.restaurantId,
    po.po_number,
  );
  if (claim.external_reference !== expectedReference) {
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      "external reference mismatch",
      false,
    );
    return internalError(
      "xero-sync",
      new Error("Xero push reference does not match the PO"),
    );
  }

  let lookup: Awaited<ReturnType<typeof accountingRequest>>;
  try {
    lookup = await accountingRequest(context, tokens, {
      url: buildInvoiceLookupUrl(expectedReference),
    });
    tokens = lookup.tokens;
  } catch (error) {
    const reason = networkReason("invoice reconciliation", error);
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      reason,
      claim.needs_reconciliation === true,
    );
    await logPushError(context.db, context.restaurantId, po.po_number, reason);
    return error instanceof XeroTokenRefreshFailure
      ? refreshFailureResponse(error.reason)
      : errorJson(502, "xero_reconciliation_failed", reason);
  }
  if (!lookup.response.ok || !lookup.body) {
    const reason = `invoice reconciliation HTTP ${lookup.response.status}`;
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      reason,
      claim.needs_reconciliation === true,
    );
    await logPushError(context.db, context.restaurantId, po.po_number, reason);
    return errorJson(502, "xero_reconciliation_failed", reason);
  }

  let invoiceMatches: ReturnType<typeof parseInvoiceMatchesByReference>;
  try {
    invoiceMatches = parseInvoiceMatchesByReference(
      lookup.body,
      expectedReference,
    );
  } catch (error) {
    const reason = xeroFailure(error, "bad_invoice_lookup_response");
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      reason,
      claim.needs_reconciliation === true,
    );
    await logPushError(context.db, context.restaurantId, po.po_number, reason);
    return errorJson(502, "xero_reconciliation_invalid_response", reason);
  }
  if (invoiceMatches.length > 1) {
    const reason = "multiple Xero bills share the external PO reference";
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      reason,
      true,
    );
    await logPushError(context.db, context.restaurantId, po.po_number, reason);
    return errorJson(409, "xero_invoice_ambiguous", reason);
  }

  if (
    invoiceMatches.length === 1 &&
    invoiceMatches[0].totalMinor !== po.total_minor
  ) {
    const reason = `Xero bill total ${
      invoiceMatches[0].totalMinor
    } does not match PO total ${po.total_minor}`;
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      reason,
      true,
    );
    await logPushError(context.db, context.restaurantId, po.po_number, reason);
    return errorJson(409, "xero_invoice_total_mismatch", reason);
  }

  let xeroInvoiceId = invoiceMatches[0]?.invoiceId;
  let reconciled = Boolean(xeroInvoiceId);
  if (!xeroInvoiceId) {
    let contact: ContactResolutionSuccess | ContactResolutionFailure;
    try {
      contact = await resolveSupplierContact(
        context,
        tokens,
        po.supplier_name,
      );
    } catch (error) {
      const reason = xeroFailure(error, "contact resolution failed");
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        reason,
        false,
      );
      await logPushError(
        context.db,
        context.restaurantId,
        po.po_number,
        reason,
      );
      return errorJson(409, "xero_contact_resolution_failed", reason);
    }
    tokens = contact.tokens;
    if (!contact.ok) {
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        contact.reason,
        false,
      );
      await logPushError(
        context.db,
        context.restaurantId,
        po.po_number,
        contact.reason,
      );
      return contact.response;
    }
    let payload: Record<string, unknown>;
    try {
      payload = buildBillPayload(
        {
          po_number: po.po_number,
          supplier_name: po.supplier_name,
          currency: po.currency,
          created_at: po.created_at,
          subtotal_minor: po.subtotal_minor,
          tax_total_minor: po.tax_total_minor,
          withholding_minor: po.withholding_minor,
          total_minor: po.total_minor,
          lines: lines.map((line) => ({
            description: line.description,
            quantity_milli: Math.round(Number(line.quantity) * 1000),
            unit_price_minor: line.unit_price_minor,
            line_subtotal_minor: line.line_subtotal_minor,
          })),
        } satisfies PoForXero,
        contact.contactId,
        expectedReference,
        context.accountCode,
      );
    } catch (error) {
      const reason = xeroFailure(error, "invoice payload validation failed");
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        reason,
        false,
      );
      await logPushError(
        context.db,
        context.restaurantId,
        po.po_number,
        reason,
      );
      return errorJson(409, "xero_payload_invalid", reason);
    }

    const { data: attemptData, error: attemptError } = await context.db.rpc(
      "begin_xero_invoice_post_attempt",
      {
        p_restaurant_id: context.restaurantId,
        p_po_id: poId,
        p_claim_token: claim.claim_token,
      },
    );
    if (attemptError) {
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        "invoice attempt allocation failed",
        claim.needs_reconciliation === true,
      );
      return internalError("xero-sync", attemptError);
    }
    const attempt = attemptData as PostAttempt | null;
    if (!attempt?.idempotency_key) {
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        "invalid invoice attempt response",
        true,
      );
      return internalError(
        "xero-sync",
        new Error("invalid Xero invoice attempt response"),
      );
    }

    let created: Awaited<ReturnType<typeof accountingRequest>>;
    try {
      created = await accountingRequest(context, tokens, {
        url: XERO_INVOICES_URL,
        method: "POST",
        idempotencyKey: attempt.idempotency_key,
        body: payload,
      });
      tokens = created.tokens;
    } catch (error) {
      const reason = networkReason("invoice create", error);
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        reason,
        true,
      );
      await logPushError(
        context.db,
        context.restaurantId,
        po.po_number,
        reason,
      );
      return error instanceof XeroTokenRefreshFailure
        ? refreshFailureResponse(error.reason)
        : errorJson(502, "xero_push_failed", reason);
    }
    if (!created.response.ok || !created.body) {
      const reason = `invoice create HTTP ${created.response.status}`;
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        reason,
        true,
      );
      await logPushError(
        context.db,
        context.restaurantId,
        po.po_number,
        reason,
      );
      return errorJson(502, "xero_push_failed", reason);
    }
    try {
      const createdInvoice = parseCreatedInvoiceResult(created.body);
      if (createdInvoice.totalMinor !== po.total_minor) {
        throw new XeroResponseError(
          "invoice_total_mismatch",
          `Xero returned total ${createdInvoice.totalMinor}; expected ${po.total_minor}`,
        );
      }
      xeroInvoiceId = createdInvoice.invoiceId;
    } catch (error) {
      const reason = xeroFailure(error, "bad_invoice_response");
      await releasePushClaim(
        context.db,
        context.restaurantId,
        poId,
        claim.claim_token,
        reason,
        true,
      );
      await logPushError(
        context.db,
        context.restaurantId,
        po.po_number,
        reason,
      );
      return errorJson(502, "xero_push_invalid_response", reason);
    }
    reconciled = false;
  }

  const { data: completion, error: completionError } = await context.db.rpc(
    "complete_xero_invoice_push",
    {
      p_restaurant_id: context.restaurantId,
      p_po_id: poId,
      p_claim_token: claim.claim_token,
      p_xero_invoice_id: xeroInvoiceId,
      p_actor_id: context.actorId,
    },
  );
  if (completionError) {
    await releasePushClaim(
      context.db,
      context.restaurantId,
      poId,
      claim.claim_token,
      "database finalize failed after external invoice success",
      true,
    );
    return internalError("xero-sync", completionError);
  }
  const completed = completion as {
    completed?: boolean;
    already_completed?: boolean;
  } | null;
  if (
    !completed ||
    (completed.completed !== true && completed.already_completed !== true)
  ) {
    return internalError(
      "xero-sync",
      new Error("invalid Xero invoice completion response"),
    );
  }
  return json(200, {
    pushed: completed?.completed === true,
    reconciled,
    alreadyPushed: completed?.already_completed === true,
    xeroInvoiceId,
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const clientId = Deno.env.get("XERO_CLIENT_ID");
    const clientSecret = Deno.env.get("XERO_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return json(503, {
        error: "not_configured",
        missing: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
      });
    }

    const caller = await resolveCaller(req);
    if (!caller) return errorJson(401, "not_authenticated");
    if (caller.role !== "manager") return errorJson(403, "manager_required");

    const db = serviceClient();

    const { data: entitled, error: entitlementError } = await db.rpc(
      "has_entitlement",
      {
        p_restaurant_id: caller.restaurantId,
        p_feature: "billing_pro",
      },
    );
    if (entitlementError) {
      return internalError("xero-sync", entitlementError);
    }
    if (!entitled) return errorJson(403, "entitlement_required");

    const body = await req.json().catch(() => null) as
      | { action?: "push_invoice"; poId?: string }
      | { action?: "import_bills" }
      | null;
    if (!body?.action) {
      return errorJson(400, "bad_request", "action is required");
    }
    const accountCode = Deno.env.get("XERO_DEFAULT_ACCOUNT_CODE")?.trim();
    if (body.action === "push_invoice" && !accountCode) {
      return json(503, {
        error: "not_configured",
        missing: ["XERO_DEFAULT_ACCOUNT_CODE"],
      });
    }

    // Tokens (encrypted at rest; only this service context can read them)
    const { data: tokenRows, error: tokenError } = await db.rpc(
      "get_xero_tokens",
      {
        p_restaurant_id: caller.restaurantId,
      },
    );
    if (tokenError) return internalError("xero-sync", tokenError);
    let tokens = (tokenRows as Tokens[] | null)?.[0];
    if (!tokens) return errorJson(409, "xero_not_connected");
    if (tokens.status !== "connected") {
      return errorJson(409, "xero_connection_" + tokens.status);
    }
    if (!hasUsableTokenMaterial(tokens)) {
      return errorJson(409, "xero_connection_invalid");
    }

    if (needsRefresh(tokens.access_expires_at, new Date())) {
      const refreshed = await refreshTokens(
        db,
        caller.restaurantId,
        tokens,
        clientId,
        clientSecret,
      );
      if (!refreshed.ok) {
        return refreshFailureResponse(refreshed.reason);
      }
      if (!hasUsableTokenMaterial(refreshed.tokens)) {
        return refreshFailureResponse("token_material_invalid");
      }
      tokens = refreshed.tokens;
    }

    // ---------------------------------------------------------- push_invoice
    if (body.action === "push_invoice") {
      const poId = (body as { poId?: string }).poId;
      if (!poId) return errorJson(400, "bad_request", "poId is required");

      // Caller's JWT → RLS proves the PO belongs to their restaurant.
      const asUser = userClient(req);
      const { data: po, error: poError } = await asUser
        .from("purchase_orders")
        .select(
          "id, po_number, supplier_name, status, currency, created_at, xero_invoice_id, subtotal_minor, tax_total_minor, withholding_minor, total_minor",
        )
        .eq("id", poId)
        .maybeSingle();
      if (poError) return internalError("xero-sync", poError);
      if (!po) return errorJson(404, "po_not_found");
      if (po.status !== "approved") return errorJson(409, "po_not_approved");
      if (po.xero_invoice_id) {
        return json(200, {
          pushed: false,
          alreadyPushed: true,
          xeroInvoiceId: po.xero_invoice_id,
        });
      }

      const { data: lines, error: linesError } = await asUser
        .from("purchase_order_lines")
        .select("description, quantity, unit_price_minor, line_subtotal_minor")
        .eq("purchase_order_id", poId);
      if (linesError) return internalError("xero-sync", linesError);
      if (!lines || lines.length === 0) {
        return errorJson(409, "po_has_no_lines");
      }

      return executeInvoicePush({
        context: {
          db,
          restaurantId: caller.restaurantId,
          actorId: caller.userId,
          clientId,
          clientSecret,
          accountCode: accountCode!,
        },
        tokens,
        poId,
        po,
        lines,
      });
    }

    // ---------------------------------------------------------- import_bills
    if (body.action === "import_bills") {
      const importStartedAt = new Date().toISOString();
      const pageSize = 100; // Xero Accounting API's documented page size.
      const maxBills = 10_000;
      // One sentinel page lets an exactly-full 10,000-row import prove EOF.
      const maxPages = Math.floor(maxBills / pageSize) + 1;
      const billsById = new Map<
        string,
        ReturnType<typeof parseBillPage>["bills"][number]
      >();
      let pagesFetched = 0;
      let rowsFetched = 0;
      let completeSnapshot = false;

      // No local mirror mutation occurs until every page has been fetched and
      // parsed. A network/parse failure therefore cannot make unseen rows look
      // stale. Each page gets one bounded request and at most one 401 refresh.
      for (let page = 1; page <= maxPages; page += 1) {
        const importUrl = new URL(XERO_INVOICES_URL);
        importUrl.searchParams.set("where", 'Type=="ACCPAY"');
        importUrl.searchParams.set("order", "Date DESC");
        importUrl.searchParams.set("page", String(page));

        let importRes: Response;
        try {
          const result = await requestWithOneRefresh(
            db,
            caller.restaurantId,
            tokens,
            clientId,
            clientSecret,
            (current) =>
              requestXero(fetch, {
                url: importUrl.toString(),
                accessToken: current.access_token,
                tenantId: current.xero_tenant_id,
                signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
              }),
          );
          tokens = result.tokens;
          importRes = result.response;
        } catch (err) {
          const reason = err instanceof XeroTokenRefreshFailure
            ? `token refresh failed: ${err.reason}`
            : err instanceof Error
            ? `network error: ${err.message}`
            : "network error";
          const { error: logError } = await db.from("xero_sync_log").insert({
            restaurant_id: caller.restaurantId,
            operation: "bill_import",
            direction: "pull",
            status: "error",
            error: reason,
            summary: { failed_page: page },
          });
          if (logError) {
            console.error("[xero-sync] import error log", logError);
          }
          return err instanceof XeroTokenRefreshFailure
            ? refreshFailureResponse(err.reason)
            : errorJson(502, "xero_import_failed", "network error");
        }

        const importJson = await importRes.json().catch(() => null);
        if (!importRes.ok || !importJson) {
          const { error: logError } = await db.from("xero_sync_log").insert({
            restaurant_id: caller.restaurantId,
            operation: "bill_import",
            direction: "pull",
            status: "error",
            error: `HTTP ${importRes.status}`,
            summary: { failed_page: page },
          });
          if (logError) console.error("[xero-sync] import HTTP log", logError);
          return errorJson(
            502,
            "xero_import_failed",
            `HTTP ${importRes.status}`,
          );
        }

        let parsedPage: ReturnType<typeof parseBillPage>;
        try {
          parsedPage = parseBillPage(importJson);
        } catch (err) {
          const reason = err instanceof XeroResponseError
            ? `${err.code}: ${err.message}`
            : "bad_invoices_response";
          const { error: logError } = await db.from("xero_sync_log").insert({
            restaurant_id: caller.restaurantId,
            operation: "bill_import",
            direction: "pull",
            status: "error",
            error: reason,
            summary: { failed_page: page },
          });
          if (logError) console.error("[xero-sync] import parse log", logError);
          return errorJson(502, "xero_import_invalid_response", reason);
        }

        pagesFetched = page;
        rowsFetched += parsedPage.responseCount;
        if (rowsFetched > maxBills) break;
        for (const bill of parsedPage.bills) {
          billsById.set(bill.xeroInvoiceId.toLowerCase(), {
            ...bill,
            xeroInvoiceId: bill.xeroInvoiceId.toLowerCase(),
          });
        }
        if (parsedPage.responseCount < pageSize) {
          completeSnapshot = true;
          break;
        }
      }

      if (!completeSnapshot) {
        const reason =
          `bill import exceeded the ${maxBills}-row safety limit`;
        const { error: logError } = await db.from("xero_sync_log").insert({
          restaurant_id: caller.restaurantId,
          operation: "bill_import",
          direction: "pull",
          status: "error",
          error: reason,
          summary: { pages_fetched: pagesFetched, rows_fetched: rowsFetched },
        });
        if (logError) console.error("[xero-sync] import limit log", logError);
        return errorJson(409, "xero_import_too_large", reason);
      }

      const bills = [...billsById.values()];
      const { data: mirrorData, error: mirrorError } = await db.rpc(
        "reconcile_xero_bill_mirror",
        {
          p_restaurant_id: caller.restaurantId,
          p_seen_at: importStartedAt,
          p_bills: bills.map((b) => ({
            xero_invoice_id: b.xeroInvoiceId,
            contact_name: b.contactName,
            xero_status: b.status,
            invoice_date: b.date,
            due_date: b.dueDate,
            total: b.total,
            currency: b.currency,
            raw: b.raw,
          })),
        },
      );
      if (mirrorError) return internalError("xero-sync", mirrorError);
      const mirror = mirrorData as {
        seen?: number;
        upserted?: number;
        stale_marked?: number;
      } | null;
      if (!mirror || mirror.seen !== bills.length) {
        return internalError(
          "xero-sync",
          new Error("invalid Xero mirror reconciliation response"),
        );
      }

      const { error: successLogError } = await db.from("xero_sync_log").insert({
        restaurant_id: caller.restaurantId,
        operation: "bill_import",
        direction: "pull",
        status: "success",
        summary: {
          imported: bills.length,
          pages: pagesFetched,
          stale_marked: mirror?.stale_marked ?? 0,
        },
      });
      if (successLogError) return internalError("xero-sync", successLogError);

      const { error: auditError } = await db.rpc("log_audit", {
        p_restaurant_id: caller.restaurantId,
        p_actor_id: caller.userId,
        p_actor_type: "xero",
        p_action: "xero.bills_imported",
        p_entity_type: "xero_bills",
        p_entity_id: null,
        p_detail: {
          imported: bills.length,
          pages: pagesFetched,
          stale_marked: mirror?.stale_marked ?? 0,
        },
      });
      if (auditError) return internalError("xero-sync", auditError);

      return json(200, {
        imported: bills.length,
        pages: pagesFetched,
        staleMarked: mirror?.stale_marked ?? 0,
      });
    }

    return errorJson(400, "bad_request", `unknown action`);
  } catch (err) {
    return internalError("xero-sync", err);
  }
});
