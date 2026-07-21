/** Xero client core — builders and parsers, no network. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAppRedirectUrl,
  buildAuthorizeUrl,
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
  parseBills,
  parseConnections,
  parseContactIdsByName,
  parseContactIdsByNumber,
  parseCreatedContactId,
  parseCreatedInvoiceId,
  parseCreatedInvoiceResult,
  parseInvoiceIdsByReference,
  parseInvoiceMatchesByReference,
  parseTokenResponse,
  parseXeroDate,
  requestXero,
  resolveRefreshFailure,
  sanitizeInternalPath,
  withOne401Retry,
  XeroResponseError,
} from "../supabase/functions/_shared/core/xero-core.ts";

describe("buildAuthorizeUrl", () => {
  it("assembles the authorize URL with encoded params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "CLIENT",
        redirectUri: "https://x.supabase.co/functions/v1/xero-oauth-callback",
        state: "abc-123",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.xero.com/identity/connect/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("CLIENT");
    expect(url.searchParams.get("state")).toBe("abc-123");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toContain("accounting.invoices");
  });
});

describe("same-origin OAuth redirects", () => {
  it("preserves a normal app path and its query/hash", () => {
    expect(sanitizeInternalPath("/dashboard/settings/xero?tab=bills#latest"))
      .toBe(
        "/dashboard/settings/xero?tab=bills#latest",
      );
  });

  it.each([
    "//attacker.example/steal",
    "/\\attacker.example/steal",
    "https://attacker.example/steal",
    "javascript:alert(1)",
    "dashboard/settings/xero",
  ])("rejects an external or non-absolute path: %s", (value) => {
    expect(sanitizeInternalPath(value)).toBe("/dashboard/settings/xero");
  });

  it("builds callback redirects on APP_BASE_URL even for a hostile stored row", () => {
    const redirect = new URL(
      buildAppRedirectUrl("https://app.example", "//attacker.example/steal", {
        xero_error: "invalid_state",
      }),
    );
    expect(redirect.origin).toBe("https://app.example");
    expect(redirect.pathname).toBe("/dashboard/settings/xero");
    expect(redirect.searchParams.get("xero_error")).toBe("invalid_state");
  });

  it.each([
    "http://app.example",
    "https://app.example/dashboard",
    "https://app.example?next=/dashboard",
    "https://app.example#fragment",
    "https://user:pass@app.example",
  ])("rejects a non-HTTPS or non-origin APP_BASE_URL: %s", (value) => {
    expect(() => buildAppRedirectUrl(value, "/dashboard", {})).toThrow(
      XeroResponseError,
    );
  });
});

describe("parseTokenResponse", () => {
  it("computes expiry from expires_in", () => {
    const now = new Date("2026-07-21T10:00:00Z");
    const t = parseTokenResponse(
      { access_token: "at", refresh_token: "rt", expires_in: 1800 },
      now,
    );
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe("rt");
    expect(t.expiresAt).toBe("2026-07-21T10:30:00.000Z");
  });

  it("rejects malformed responses", () => {
    expect(() => parseTokenResponse({}, new Date())).toThrow(XeroResponseError);
    expect(() => parseTokenResponse({ access_token: "x" }, new Date())).toThrow(
      XeroResponseError,
    );
    expect(() => parseTokenResponse(null, new Date())).toThrow(
      XeroResponseError,
    );
    expect(() =>
      parseTokenResponse(
        { access_token: "x", refresh_token: "y", expires_in: -1 },
        new Date(),
      )
    ).toThrow(XeroResponseError);
  });
});

describe("needsRefresh", () => {
  const now = new Date("2026-07-21T10:00:00Z");
  it("true when missing, expired, or inside the skew window", () => {
    expect(needsRefresh(null, now)).toBe(true);
    expect(needsRefresh("2026-07-21T09:00:00Z", now)).toBe(true);
    expect(needsRefresh("2026-07-21T10:01:00Z", now)).toBe(true); // 60s < 120s skew
    expect(needsRefresh("not-a-date", now)).toBe(true);
  });
  it("false with a comfortably fresh token", () => {
    expect(needsRefresh("2026-07-21T10:30:00Z", now)).toBe(false);
  });
});

describe("withOne401Retry", () => {
  it("refreshes once after 401 and retries with the new token", async () => {
    const requests: string[] = [];
    let refreshes = 0;
    const result = await withOne401Retry({
      token: "expired",
      request: async (token) => {
        requests.push(token);
        return { status: token === "expired" ? 401 : 200 };
      },
      refresh: async () => {
        refreshes += 1;
        return "fresh";
      },
      status: (response) => response.status,
    });

    expect(result.response.status).toBe(200);
    expect(result.token).toBe("fresh");
    expect(result.retried).toBe(true);
    expect(requests).toEqual(["expired", "fresh"]);
    expect(refreshes).toBe(1);
  });

  it("never retries a second 401", async () => {
    let requests = 0;
    let refreshes = 0;
    const result = await withOne401Retry({
      token: "expired",
      request: async () => {
        requests += 1;
        return { status: 401 };
      },
      refresh: async () => {
        refreshes += 1;
        return "still-invalid";
      },
      status: (response) => response.status,
    });

    expect(result.response.status).toBe(401);
    expect(requests).toBe(2);
    expect(refreshes).toBe(1);
  });

  it("does not refresh non-401 responses", async () => {
    let refreshes = 0;
    const result = await withOne401Retry({
      token: "token",
      request: async () => ({ status: 500 }),
      refresh: async (token) => {
        refreshes += 1;
        return token;
      },
      status: (response) => response.status,
    });
    expect(result.retried).toBe(false);
    expect(refreshes).toBe(0);
  });
});

describe("refresh winner/loser fencing", () => {
  it("marks a genuinely current failed grant expired", async () => {
    let reads = 0;
    const result = await resolveRefreshFailure({
      markExpiredIfCurrent: async () => true,
      readCurrent: async () => {
        reads += 1;
        return { refresh: "new" };
      },
    });
    expect(result).toEqual({ kind: "expired" });
    expect(reads).toBe(0);
  });

  it("reuses the concurrent winner when the failed token is stale", async () => {
    const winner = { refresh: "winner", status: "connected" };
    const result = await resolveRefreshFailure({
      markExpiredIfCurrent: async () => false,
      readCurrent: async () => winner,
    });
    expect(result).toEqual({ kind: "superseded", current: winner });
  });

  it("distinguishes terminal invalid_grant from retryable outages", () => {
    expect(classifyRefreshFailure("refresh_grant_expired")).toEqual({
      terminal: true,
      status: 409,
      code: "xero_connection_expired",
    });
    for (
      const reason of [
        "refresh_transient_failure",
        "refresh_recovery_failed",
        "token_store_failed",
        "token_reread_failed",
      ]
    ) {
      expect(classifyRefreshFailure(reason)).toEqual({
        terminal: false,
        status: 503,
        code: "xero_refresh_temporarily_unavailable",
      });
    }
  });
});

describe("parseConnections", () => {
  it("extracts tenants and rejects non-arrays", () => {
    const tenantId = "11111111-0000-4000-8000-000000000001";
    expect(
      parseConnections([
        { tenantId, tenantName: "Demo Company (Global)" },
        { tenantId: "not-a-guid", tenantName: "Malformed" },
        { bogus: true },
      ]),
    ).toEqual([{ tenantId, tenantName: "Demo Company (Global)" }]);
    expect(() => parseConnections({})).toThrow(XeroResponseError);
  });
});

describe("Xero reconciliation identities", () => {
  const restaurantId = "11111111-0000-4000-8000-000000000001";
  const invoiceId = "8f5c2d65-53d4-4a1b-9f69-e829f5e77e44";
  const contactId = "97c2dc5e-e907-4b4e-8210-54d82b0aa479";

  it("builds an organisation-safe exact invoice reference and lookup", () => {
    const reference = buildXeroReference(restaurantId, "PO-2026-0001");
    expect(reference).toBe(`RM:${restaurantId}:PO-2026-0001`);
    const url = new URL(buildInvoiceLookupUrl(reference));
    expect(url.pathname).toBe("/api.xro/2.0/Invoices");
    expect(url.searchParams.get("where")).toBe(
      `Type=="ACCPAY" AND Reference=="${reference}"`,
    );
  });

  it("normalizes suppliers and builds a deterministic external contact number", async () => {
    expect(normalizeSupplierKey("  Fresh   FARMS Ltd  ")).toBe(
      "fresh farms ltd",
    );
    const contactNumber = await buildExternalContactNumber(
      restaurantId,
      "fresh farms ltd",
    );
    expect(contactNumber).toBe("RM:8c2b419da5d5572d9ee74905");
    expect(
      await buildExternalContactNumber(restaurantId, "fresh farms ltd"),
    ).toBe(contactNumber);
    expect(
      decodeURIComponent(
        new URL(buildContactNumberLookupUrl(contactNumber)).pathname,
      ).endsWith(`/Contacts/${contactNumber}`),
    ).toBe(true);
    const url = new URL(buildContactLookupUrl('Fresh "Farms" Ltd'));
    expect(url.searchParams.get("searchTerm")).toBe('Fresh "Farms" Ltd');
    expect(url.searchParams.has("where")).toBe(false);
    expect(buildContactPayload("  Fresh   Farms Ltd ", contactNumber)).toEqual({
      Contacts: [{ Name: "Fresh Farms Ltd", ContactNumber: contactNumber }],
    });
  });

  it("finds only exact normalized contacts and surfaces duplicate ids", () => {
    expect(
      parseContactIdsByName(
        {
          Contacts: [
            { ContactID: contactId, Name: "Fresh Farms Ltd" },
            { ContactID: invoiceId, Name: "Fresh Food Ltd" },
            { ContactID: invoiceId, Name: " fresh   farms LTD " },
          ],
        },
        "Fresh Farms Ltd",
      ),
    ).toEqual([contactId, invoiceId]);
    expect(parseCreatedContactId({ Contacts: [{ ContactID: contactId }] }))
      .toBe(contactId);
    expect(() => parseCreatedContactId({ Contacts: [{ HasErrors: true }] }))
      .toThrow(XeroResponseError);
  });

  it("matches a deterministic ContactNumber exactly", () => {
    const number = "RM:0123456789abcdef01234567";
    expect(
      parseContactIdsByNumber(
        {
          Contacts: [
            { ContactID: contactId, ContactNumber: number },
          ],
        },
        number,
      ),
    ).toEqual([contactId]);
    expect(() =>
      parseContactIdsByNumber(
        { Contacts: [{ ContactID: contactId, ContactNumber: `${number}x` }] },
        number,
      )
    ).toThrow(XeroResponseError);
  });

  it("reconciles exact ACCPAY references and preserves ambiguity", () => {
    const reference = buildXeroReference(restaurantId, "PO-2026-0001");
    expect(
      parseInvoiceIdsByReference(
        {
          Invoices: [
            { Type: "ACCPAY", Reference: reference, InvoiceID: invoiceId },
            { Type: "ACCREC", Reference: reference, InvoiceID: contactId },
            { Type: "ACCPAY", Reference: "other", InvoiceID: contactId },
          ],
        },
        reference,
      ),
    ).toEqual([invoiceId]);
    expect(
      parseInvoiceIdsByReference(
        {
          Invoices: [
            { Type: "ACCPAY", Reference: reference, InvoiceID: invoiceId },
            { Type: "ACCPAY", Reference: reference, InvoiceID: contactId },
          ],
        },
        reference,
      ),
    ).toEqual([invoiceId, contactId]);
  });

  it("uses an injected fetch boundary with tenant auth and attempt key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = await requestXero(
      async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ Contacts: [] }), { status: 200 });
      },
      {
        url: "https://api.xero.com/api.xro/2.0/Contacts",
        accessToken: "access",
        tenantId: "tenant",
        method: "POST",
        idempotencyKey: "restamenu:contact:attempt",
        body: { Contacts: [{ Name: "Fresh Farms Ltd" }] },
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access");
    expect(headers.get("xero-tenant-id")).toBe("tenant");
    expect(headers.get("Idempotency-Key")).toBe(
      "restamenu:contact:attempt",
    );
  });
});

describe("buildBillPayload", () => {
  const contactId = "97c2dc5e-e907-4b4e-8210-54d82b0aa479";
  const reference = "RM:11111111-0000-4000-8000-000000000001:PO-2026-0001";
  const po = {
    po_number: "PO-2026-0001",
    supplier_name: "Fresh Farms Ltd",
    currency: "EUR",
    created_at: "2026-07-21T09:30:00.000Z",
    subtotal_minor: 625,
    tax_total_minor: 131,
    withholding_minor: 25,
    total_minor: 731,
    lines: [
      {
        description: "Tomatoes",
        quantity_milli: 2500,
        unit_price_minor: 250,
        line_subtotal_minor: 625,
      },
    ],
  };

  it("builds a DRAFT ACCPAY invoice with major-unit amounts and no forced AccountCode", () => {
    const payload = buildBillPayload(po, contactId, reference) as {
      Invoices: Array<
        Record<string, unknown> & { LineItems: Array<Record<string, unknown>> }
      >;
    };
    const inv = payload.Invoices[0];
    expect(inv.Type).toBe("ACCPAY");
    expect(inv.Status).toBe("DRAFT");
    expect(inv.Reference).toBe(reference);
    expect(inv.Date).toBe("2026-07-21");
    expect((inv.Contact as { ContactID: string }).ContactID).toBe(contactId);
    expect(inv.LineAmountTypes).toBe("NoTax");
    expect(inv.LineItems[0].Quantity).toBe(1);
    expect(inv.LineItems[0].UnitAmount).toBe(6.25);
    expect(inv.LineItems[1].UnitAmount).toBe(1.31);
    expect(inv.LineItems[2].UnitAmount).toBe(-0.25);
    expect(
      inv.LineItems.reduce(
        (total, line) => total + Number(line.UnitAmount),
        0,
      ),
    ).toBeCloseTo(7.31, 10);
    expect(inv.LineItems[0].AccountCode).toBeUndefined();
  });

  it("includes AccountCode when configured", () => {
    const payload = buildBillPayload(po, contactId, reference, " 310 ") as {
      Invoices: Array<{ LineItems: Array<Record<string, unknown>> }>;
    };
    expect(payload.Invoices[0].LineItems[0].AccountCode).toBe("310");
    expect(payload.Invoices[0].LineItems[1].AccountCode).toBe("310");
    expect(payload.Invoices[0].LineItems[2].AccountCode).toBe("310");
  });

  it("omits a blank AccountCode for an intentionally incomplete DRAFT", () => {
    const payload = buildBillPayload(po, contactId, reference, "   ") as {
      Invoices: Array<{ LineItems: Array<Record<string, unknown>> }>;
    };
    expect(payload.Invoices[0].LineItems[0].AccountCode).toBeUndefined();
  });

  it("refuses display-name-only contacts or unsafe references", () => {
    expect(() => buildBillPayload(po, "not-a-guid", reference)).toThrow(
      XeroResponseError,
    );
    expect(() => buildBillPayload(po, contactId, "unsafe reference"))
      .toThrow(XeroResponseError);
    expect(() =>
      buildBillPayload(
        { ...po, total_minor: po.total_minor + 1 },
        contactId,
        reference,
      )
    ).toThrow(XeroResponseError);
  });
});

describe("parseCreatedInvoiceId", () => {
  const invoiceId = "8f5c2d65-53d4-4a1b-9f69-e829f5e77e44";

  it("requires the durable Xero InvoiceID", () => {
    expect(parseCreatedInvoiceId({ Invoices: [{ InvoiceID: invoiceId }] }))
      .toBe(invoiceId);
  });

  it.each([
    null,
    {},
    { Invoices: [] },
    { Invoices: [{ InvoiceID: "" }] },
    { Invoices: [{ InvoiceID: "not-a-guid" }] },
    { Invoices: [{ InvoiceID: invoiceId, HasErrors: true }] },
  ])("rejects an ambiguous or validation-error response", (response) => {
    expect(() => parseCreatedInvoiceId(response)).toThrow(XeroResponseError);
  });

  it("requires and converts Xero's returned total for final reconciliation", () => {
    expect(
      parseCreatedInvoiceResult({
        Invoices: [{ InvoiceID: invoiceId, Total: 7.31 }],
      }),
    ).toEqual({ invoiceId, totalMinor: 731 });
    expect(() =>
      parseCreatedInvoiceResult({ Invoices: [{ InvoiceID: invoiceId }] })
    ).toThrow(XeroResponseError);
  });

  it("returns exact reference matches with their authoritative totals", () => {
    const reference = "RM:11111111-0000-4000-8000-000000000001:PO-2026-0001";
    expect(
      parseInvoiceMatchesByReference(
        {
          Invoices: [{
            Type: "ACCPAY",
            Reference: reference,
            InvoiceID: invoiceId,
            Total: 7.31,
          }],
        },
        reference,
      ),
    ).toEqual([{ invoiceId, totalMinor: 731 }]);
  });
});

describe("parseXeroDate / parseBills", () => {
  const billId = "8f5c2d65-53d4-4a1b-9f69-e829f5e77e44";

  it("handles both ISO and /Date(ms)/ formats", () => {
    expect(parseXeroDate("2026-07-21T00:00:00")).toBe("2026-07-21");
    expect(parseXeroDate("/Date(1784592000000+0000)/")).toBe("2026-07-21");
    expect(parseXeroDate(12345)).toBeNull();
    expect(parseXeroDate("not a date")).toBeNull();
    expect(parseXeroDate("/Date(999999999999999999999)/")).toBeNull();
  });

  it("keeps only ACCPAY invoices with ids", () => {
    const bills = parseBills({
      Invoices: [
        {
          Type: "ACCPAY",
          InvoiceID: billId,
          Contact: { Name: "Vendor" },
          Status: "AUTHORISED",
          DateString: "2026-07-20T00:00:00",
          DueDateString: "2026-08-20T00:00:00",
          Total: 120.5,
          CurrencyCode: "EUR",
        },
        {
          Type: "ACCREC",
          InvoiceID: "97c2dc5e-e907-4b4e-8210-54d82b0aa479",
        },
      ],
    });
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      xeroInvoiceId: billId,
      contactName: "Vendor",
      status: "AUTHORISED",
      date: "2026-07-20",
      dueDate: "2026-08-20",
      total: 120.5,
      currency: "EUR",
    });
  });

  it("preserves the raw response count needed for complete pagination", () => {
    const page = parseBillPage({
      Invoices: [
        {
          Type: "ACCPAY",
          InvoiceID: billId,
          Total: 1,
        },
        {
          Type: "ACCREC",
          InvoiceID: "97c2dc5e-e907-4b4e-8210-54d82b0aa479",
        },
      ],
    });
    expect(page.responseCount).toBe(2);
    expect(page.bills).toHaveLength(1);
  });

  it("rejects malformed responses", () => {
    expect(() => parseBills({ nope: 1 })).toThrow(XeroResponseError);
    expect(() =>
      parseBills({
        ErrorNumber: 10,
        Type: "ValidationException",
        Message: "invalid query",
      })
    ).toThrow(XeroResponseError);
    expect(() =>
      parseBills({
        Invoices: [{ Type: "ACCPAY", InvoiceID: "not-a-guid" }],
      })
    ).toThrow(XeroResponseError);
    expect(() =>
      parseBills({
        Invoices: [{ Type: "ACCPAY" }],
      })
    ).toThrow(XeroResponseError);
  });

  it("normalizes invalid scalar fields instead of trusting their asserted types", () => {
    const [bill] = parseBills({
      Invoices: [{
        Type: "ACCPAY",
        InvoiceID: billId,
        Contact: { Name: 42 },
        Status: 42,
        Total: Number.POSITIVE_INFINITY,
        CurrencyCode: 42,
      }],
    });
    expect(bill).toMatchObject({
      contactName: null,
      status: null,
      total: null,
      currency: null,
    });
  });
});

describe("Xero retry/mapping migration contract", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/025_xero_idempotency.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const syncFunction = readFileSync(
    new URL(
      "../supabase/functions/xero-sync/index.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const oauthCallback = readFileSync(
    new URL(
      "../supabase/functions/xero-oauth-callback/index.ts",
      import.meta.url,
    ),
    "utf8",
  );

  it("persists ContactID mappings and a tenant-qualified invoice reference", () => {
    expect(migration).toContain("create table public.xero_contact_mappings");
    expect(migration).toContain("xero_contact_id");
    expect(migration).toContain("external_contact_number");
    expect(migration).toContain("extensions.digest");
    expect(migration).toContain(
      "'RM:' || p_restaurant_id::text || ':' || v_po.po_number",
    );
    expect(migration).toContain("external_reference");
    expect(migration).toContain(
      "xero_tenant_change_requires_explicit_reset",
    );
    expect(migration).toContain(
      "lower(xc.xero_tenant_id) = lower(excluded.xero_tenant_id)",
    );
  });

  it("fences contact and invoice mutations to the current lease owner", () => {
    const fencedMutations = migration.match(
      /and claim_token = p_claim_token\s+and state = '(?:resolving|in_progress)'/g,
    );
    expect(fencedMutations?.length).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("extensions.gen_random_uuid()");
  });

  it("uses expiring per-attempt keys, never a permanent per-PO key", () => {
    expect(migration).toContain("attempt_started_at");
    expect(migration).toContain("needs_reconciliation");
    expect(migration).toContain("interval '5 minutes 30 seconds'");
    expect(migration).toContain("interval '6 minutes'");
    expect(migration).toContain("begin_xero_invoice_post_attempt");
    expect(migration).toContain("begin_xero_contact_post_attempt");
    expect(migration).not.toContain("'restamenu-po-' || p_po_id::text");
  });

  it("fences terminal refresh failure to the token that actually failed", () => {
    expect(migration).toContain("mark_xero_connection_if_current");
    expect(migration).toContain("v_current <> p_old_refresh");
    expect(syncFunction).toContain("resolveRefreshFailure<Tokens>");
    expect(syncFunction).not.toContain('db.rpc("mark_xero_connection",');
  });

  it("reconciles before allocating or sending an invoice POST", () => {
    const reconcile = syncFunction.indexOf("url: buildInvoiceLookupUrl(");
    const allocate = syncFunction.indexOf(
      '"begin_xero_invoice_post_attempt"',
    );
    const post = syncFunction.indexOf("url: XERO_INVOICES_URL", allocate);
    expect(reconcile).toBeGreaterThan(0);
    expect(allocate).toBeGreaterThan(reconcile);
    expect(post).toBeGreaterThan(allocate);
    expect(syncFunction).not.toContain("stable per PO");
    expect(syncFunction).toContain('missing: ["XERO_DEFAULT_ACCOUNT_CODE"]');
  });

  it("resolves ContactNumber/name before creating and persisting ContactID", () => {
    const byNumber = syncFunction.indexOf("url: buildContactNumberLookupUrl(");
    const byName = syncFunction.indexOf("url: buildContactLookupUrl(");
    const create = syncFunction.indexOf("url: XERO_CONTACTS_URL", byName);
    const complete = syncFunction.indexOf(
      '"complete_xero_contact_resolution"',
      create,
    );
    expect(byNumber).toBeGreaterThan(0);
    expect(byName).toBeGreaterThan(byNumber);
    expect(create).toBeGreaterThan(byName);
    expect(complete).toBeGreaterThan(create);
  });

  it("imports every page with timeouts, then atomically marks absent bills stale", () => {
    expect(syncFunction).toContain("for (let page = 1; page <= maxPages");
    expect(syncFunction).toContain("parseBillPage(importJson)");
    expect(syncFunction).toContain(
      "signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS)",
    );
    expect(syncFunction).toContain('"reconcile_xero_bill_mirror"');
    expect(migration).toContain("add column is_stale boolean");
    expect(migration).toContain("last_seen_at < p_seen_at");
    expect(migration).toContain("xb.last_seen_at <= excluded.last_seen_at");
  });

  it("rechecks callback authorization and never persists raw OAuth bodies", () => {
    expect(oauthCallback).toContain('.from("restaurant_members")');
    expect(oauthCallback).toContain('membership?.role !== "manager"');
    expect(oauthCallback).toContain('xero_error: "authorization_denied"');
    expect(oauthCallback).not.toContain("summary: { body: tokenJson }");
  });

  it("maps only a fenced invalid_grant to expired", () => {
    expect(syncFunction).toContain("classifyRefreshFailure(reason)");
    expect(syncFunction).not.toContain(
      'errorJson(409, "xero_connection_expired", error.reason)',
    );
    expect(syncFunction).not.toContain(
      'errorJson(409, "xero_connection_expired", refreshed.reason)',
    );
  });
});
