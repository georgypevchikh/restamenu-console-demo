/**
 * POST { redirectTo? } → { authorizeUrl }
 *
 * First leg of the Xero OAuth dance. Manager-only. Creates a single-use
 * state row (10-minute TTL) that the callback — which arrives as an
 * unauthenticated browser redirect — uses to prove the flow started here
 * and to know which tenant/user it belongs to.
 */

import { resolveCaller, serviceClient } from "../_shared/db.ts";
import { errorJson, internalError, json } from "../_shared/http.ts";
import {
  buildAuthorizeUrl,
  sanitizeInternalPath,
} from "../_shared/core/xero-core.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const clientId = Deno.env.get("XERO_CLIENT_ID");
    const redirectUri = Deno.env.get("XERO_REDIRECT_URI");
    if (!clientId || !redirectUri) {
      return json(503, {
        error: "not_configured",
        missing: [
          ...(clientId ? [] : ["XERO_CLIENT_ID"]),
          ...(redirectUri ? [] : ["XERO_REDIRECT_URI"]),
        ],
      });
    }

    const caller = await resolveCaller(req);
    if (!caller) return errorJson(401, "not_authenticated");
    if (caller.role !== "manager") return errorJson(403, "manager_required");

    const body = await req.json().catch(() => ({})) as { redirectTo?: string };
    // Canonical same-origin path only. This rejects protocol-relative values
    // such as //attacker.example as well as backslash URL variants.
    const redirectTo = sanitizeInternalPath(body.redirectTo);

    const state = crypto.randomUUID();
    const db = serviceClient();
    const { error } = await db.from("xero_oauth_states").insert({
      state,
      restaurant_id: caller.restaurantId,
      user_id: caller.userId,
      redirect_to: redirectTo,
    });
    if (error) return internalError("xero-oauth-start", error);

    return json(200, {
      authorizeUrl: buildAuthorizeUrl({ clientId, redirectUri, state }),
    });
  } catch (err) {
    return internalError("xero-oauth-start", err);
  }
});
