/**
 * POST { challengeId, code } → { verified: true }
 *
 * Verifies an OTP code. claim_otp_attempt() locks the challenge and increments
 * the counter atomically BEFORE returning the hash/salt, so max_attempts holds
 * under concurrent requests. On success mark_otp_verified() performs a guarded
 * state transition; actually
 * approving the PO is a second, separate step: the app calls the
 * approve_purchase_order RPC as the signed-in manager, which consumes the
 * challenge (single-use) inside the same transaction as the status flip.
 */

import { serviceClient, resolveCaller } from "../_shared/db.ts";
import { json, errorJson, internalError } from "../_shared/http.ts";
import { verifyOtpCode } from "../_shared/core/otp-core.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const caller = await resolveCaller(req);
    if (!caller) return errorJson(401, "not_authenticated");

    const body = await req.json().catch(() => null) as {
      challengeId?: string;
      code?: string;
    } | null;
    if (!body?.challengeId || !body?.code) {
      return errorJson(400, "bad_request", "challengeId and code are required");
    }

    const db = serviceClient();

    const { data: claimRows, error: claimError } = await db.rpc("claim_otp_attempt", {
      p_challenge_id: body.challengeId,
      p_user_id: caller.userId,
    });
    if (claimError) return internalError("otp-verify", claimError);

    const claim = (claimRows as Array<{
      outcome: string;
      code_hash: string | null;
      salt: string | null;
      attempts_remaining: number | null;
    }> | null)?.[0];

    if (!claim || claim.outcome === "not_found") {
      return errorJson(404, "challenge_not_found");
    }
    if (claim.outcome === "consumed") return errorJson(409, "challenge_already_used");
    if (claim.outcome === "already_verified") {
      return json(200, { verified: true, alreadyVerified: true });
    }
    if (claim.outcome === "expired") return errorJson(410, "challenge_expired");
    if (claim.outcome === "max_attempts") return errorJson(429, "max_attempts_reached");
    if (claim.outcome !== "ready" || !claim.salt || !claim.code_hash) {
      return internalError("otp-verify", new Error(`unexpected claim outcome: ${claim.outcome}`));
    }

    const ok = await verifyOtpCode(body.code, claim.salt, claim.code_hash);
    if (!ok) {
      return json(401, {
        error: "invalid_code",
        attemptsRemaining: Math.max(0, claim.attempts_remaining ?? 0),
      });
    }

    const { data: marked, error: verifyError } = await db.rpc("mark_otp_verified", {
      p_challenge_id: body.challengeId,
      p_user_id: caller.userId,
    });
    if (verifyError) return internalError("otp-verify", verifyError);
    if (marked !== true) return errorJson(409, "challenge_state_changed");

    return json(200, { verified: true });
  } catch (err) {
    return internalError("otp-verify", err);
  }
});
