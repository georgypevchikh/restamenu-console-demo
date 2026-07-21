/**
 * GET ?code=...&state=...  (browser redirect from Xero; verify_jwt=false)
 *
 * Second leg of the OAuth flow. The one-time state row — created by
 * xero-oauth-start, 10-minute TTL, deleted on first use — is what
 * authenticates this request. Exchanges the code, discovers the tenant,
 * stores the token pair encrypted (store_xero_tokens → pgp_sym_encrypt with
 * the Vault key), journals the connect, and bounces the browser back to the
 * app. Errors also land in the journal and redirect with ?xero_error=.
 */

import { serviceClient } from "../_shared/db.ts";
import { errorJson, internalError } from "../_shared/http.ts";
import {
  buildAppRedirectUrl,
  parseConnections,
  parseTokenResponse,
  XERO_CONNECTIONS_URL,
  XERO_TOKEN_URL,
} from "../_shared/core/xero-core.ts";

const XERO_REQUEST_TIMEOUT_MS = 20_000;

function appRedirect(
  base: string,
  path: string,
  params: Record<string, string>,
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: buildAppRedirectUrl(base, path, params),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (req) => {
  const appBase = Deno.env.get("APP_BASE_URL");
  const fallback = "/dashboard/settings/xero";

  try {
    const clientId = Deno.env.get("XERO_CLIENT_ID");
    const clientSecret = Deno.env.get("XERO_CLIENT_SECRET");
    const redirectUri = Deno.env.get("XERO_REDIRECT_URI");
    if (!clientId || !clientSecret || !redirectUri || !appBase) {
      return errorJson(
        503,
        "not_configured",
        "XERO_CLIENT_ID / XERO_CLIENT_SECRET / XERO_REDIRECT_URI / APP_BASE_URL",
      );
    }

    // Validate configuration before consuming state or exchanging a code. A
    // malformed base must not let the OAuth side effect succeed and only then
    // fail while constructing the final browser redirect.
    buildAppRedirectUrl(appBase, fallback, {});

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    if (!state || (!code && !oauthError)) {
      return appRedirect(appBase, fallback, {
        xero_error: "missing_code_or_state",
      });
    }

    const db = serviceClient();

    // Single-use: delete-and-return in one statement. A replayed callback
    // finds nothing and is rejected.
    const { data: stateRow, error: stateError } = await db
      .from("xero_oauth_states")
      .delete()
      .eq("state", state)
      .gt("expires_at", new Date().toISOString())
      .select("restaurant_id, user_id, redirect_to")
      .maybeSingle();

    if (stateError) return internalError("xero-oauth-callback", stateError);

    if (!stateRow) {
      return appRedirect(appBase, fallback, {
        xero_error: "invalid_or_expired_state",
      });
    }

    const redirectTo = stateRow.redirect_to ?? fallback;

    // The manager may have been removed during the ten-minute OAuth window.
    // State proves who started the flow, but current membership is the
    // authorization boundary for binding an external accounting tenant.
    const { data: membership, error: membershipError } = await db
      .from("restaurant_members")
      .select("role")
      .eq("restaurant_id", stateRow.restaurant_id)
      .eq("user_id", stateRow.user_id)
      .maybeSingle();
    if (membershipError) {
      return internalError("xero-oauth-callback", membershipError);
    }
    if (membership?.role !== "manager") {
      return appRedirect(appBase, redirectTo, {
        xero_error: "manager_access_revoked",
      });
    }

    // Do not reflect provider-controlled error strings into the application
    // URL. The UI only needs a stable, non-sensitive category.
    if (oauthError) {
      return appRedirect(appBase, redirectTo, {
        xero_error: "authorization_denied",
      });
    }
    if (!code) {
      return appRedirect(appBase, redirectTo, {
        xero_error: "missing_code_or_state",
      });
    }

    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
    });

    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenJson) {
      const rawProviderCode = tokenJson !== null &&
          typeof tokenJson === "object" &&
          typeof (tokenJson as Record<string, unknown>)["error"] === "string"
        ? String((tokenJson as Record<string, unknown>)["error"])
        : "";
      const providerCode = /^[a-z0-9_.-]{1,64}$/i.test(rawProviderCode)
        ? rawProviderCode
        : null;
      const { error: logError } = await db.from("xero_sync_log").insert({
        restaurant_id: stateRow.restaurant_id,
        operation: "oauth_connect",
        direction: "auth",
        status: "error",
        error: `token exchange failed: HTTP ${tokenRes.status}`,
        summary: {
          http_status: tokenRes.status,
          ...(providerCode ? { provider_code: providerCode } : {}),
        },
      });
      if (logError) console.error("[xero-oauth-callback] error log", logError);
      return appRedirect(appBase, redirectTo, {
        xero_error: "token_exchange_failed",
      });
    }

    const tokens = parseTokenResponse(tokenJson, new Date());

    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
    });
    const connectionsJson = await connRes.json().catch(() => null);
    if (!connRes.ok || !connectionsJson) {
      const { error: logError } = await db.from("xero_sync_log").insert({
        restaurant_id: stateRow.restaurant_id,
        operation: "oauth_connect",
        direction: "auth",
        status: "error",
        error: `connection discovery failed: HTTP ${connRes.status}`,
      });
      if (logError) {
        console.error("[xero-oauth-callback] discovery log", logError);
      }
      return appRedirect(appBase, redirectTo, {
        xero_error: "connection_discovery_failed",
      });
    }
    const connections = parseConnections(connectionsJson);
    if (connections.length === 0) {
      const { error: logError } = await db.from("xero_sync_log").insert({
        restaurant_id: stateRow.restaurant_id,
        operation: "oauth_connect",
        direction: "auth",
        status: "error",
        error: "no Xero tenants authorised for this connection",
      });
      if (logError) {
        console.error("[xero-oauth-callback] no-tenant log", logError);
      }
      return appRedirect(appBase, redirectTo, { xero_error: "no_tenant" });
    }

    if (connections.length !== 1) {
      const { error: logError } = await db.from("xero_sync_log").insert({
        restaurant_id: stateRow.restaurant_id,
        operation: "oauth_connect",
        direction: "auth",
        status: "error",
        error: "multiple Xero tenants authorised; explicit selection required",
        summary: { tenant_count: connections.length },
      });
      if (logError) {
        console.error("[xero-oauth-callback] multi-tenant log", logError);
      }
      return appRedirect(appBase, redirectTo, {
        xero_error: "multiple_tenants_not_supported",
      });
    }

    // Never silently bind a restaurant to an arbitrary organisation.
    const tenant = connections[0];

    const { error: storeError } = await db.rpc("store_xero_tokens", {
      p_restaurant_id: stateRow.restaurant_id,
      p_access: tokens.accessToken,
      p_refresh: tokens.refreshToken,
      p_expires_at: tokens.expiresAt,
      p_tenant_id: tenant.tenantId,
      p_tenant_name: tenant.tenantName,
      p_scopes: (tokenJson as Record<string, unknown>)["scope"] as string ?? "",
      p_connected_by: stateRow.user_id,
    });
    if (storeError) {
      if (
        storeError.message.includes(
          "xero_tenant_change_requires_explicit_reset",
        )
      ) {
        return appRedirect(appBase, redirectTo, {
          xero_error: "tenant_change_requires_explicit_reset",
        });
      }
      return internalError("xero-oauth-callback", storeError);
    }

    const { error: successLogError } = await db.from("xero_sync_log").insert({
      restaurant_id: stateRow.restaurant_id,
      operation: "oauth_connect",
      direction: "auth",
      status: "success",
      summary: { tenant_name: tenant.tenantName },
    });
    if (successLogError) {
      return internalError("xero-oauth-callback", successLogError);
    }

    return appRedirect(appBase, redirectTo, { connected: "1" });
  } catch (err) {
    console.error("[xero-oauth-callback]", err);
    if (!appBase) return errorJson(503, "not_configured", "APP_BASE_URL");
    try {
      return appRedirect(appBase, fallback, { xero_error: "internal_error" });
    } catch {
      return errorJson(
        503,
        "not_configured",
        "APP_BASE_URL must be an HTTPS origin without a path, query, or fragment",
      );
    }
  }
});
