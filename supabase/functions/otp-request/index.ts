/**
 * POST { poId, phone, channel } → { challengeId, expiresAt, provider }
 *
 * Issues an OTP challenge for approving a purchase order. Manager-only.
 *
 * Order of operations matters: issue_otp_challenge() takes transaction-scoped
 * phone/IP locks, rechecks limits and writes the challenge atomically BEFORE
 * the send. A provider outage still burns the caller's cooldown slot, and a
 * burst of concurrent requests cannot all pass against an empty window.
 * The database stores HMAC-SHA256(code, salt); the code itself exists only
 * in the SMS/WhatsApp message (or the function log with OTP_PROVIDER=console).
 */

import { resolveCaller, serviceClient, userClient } from "../_shared/db.ts";
import { errorJson, internalError, json } from "../_shared/http.ts";
import {
  generateOtpCode,
  generateSalt,
  hashOtpCode,
} from "../_shared/core/otp-core.ts";
import {
  createProvider,
  type MessagingChannel,
  MessagingError,
} from "../_shared/core/messaging.ts";

const EXPIRY_MINUTES = 5;

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const caller = await resolveCaller(req);
    if (!caller) return errorJson(401, "not_authenticated");
    if (caller.role !== "manager") return errorJson(403, "manager_required");

    const body = await req.json().catch(() => null) as {
      poId?: string;
      phone?: string;
      channel?: MessagingChannel;
    } | null;

    if (!body?.poId || !body?.phone || !body?.channel) {
      return errorJson(
        400,
        "bad_request",
        "poId, phone and channel are required",
      );
    }
    if (body.channel !== "sms" && body.channel !== "whatsapp") {
      return errorJson(400, "bad_request", "channel must be sms or whatsapp");
    }
    // E.164, the only phone format Twilio accepts.
    if (!/^\+[1-9]\d{6,14}$/.test(body.phone)) {
      return errorJson(
        400,
        "bad_phone",
        "phone must be E.164, e.g. +37060000000",
      );
    }

    // The PO must exist, be visible to the caller (RLS), and still be a draft.
    const asUser = userClient(req);
    const { data: po, error: poError } = await asUser
      .from("purchase_orders")
      .select("id, status, po_number")
      .eq("id", body.poId)
      .maybeSingle();
    if (poError) return internalError("otp-request", poError);
    if (!po) return errorJson(404, "po_not_found");
    if (po.status !== "draft") return errorJson(409, "po_not_draft");

    const code = generateOtpCode();
    const salt = generateSalt();
    const codeHash = await hashOtpCode(code, salt);
    const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60_000)
      .toISOString();

    let provider;
    try {
      provider = createProvider({
        OTP_PROVIDER: Deno.env.get("OTP_PROVIDER") ?? undefined,
        TWILIO_ACCOUNT_SID: Deno.env.get("TWILIO_ACCOUNT_SID") ?? undefined,
        TWILIO_AUTH_TOKEN: Deno.env.get("TWILIO_AUTH_TOKEN") ?? undefined,
        TWILIO_SMS_FROM: Deno.env.get("TWILIO_SMS_FROM") ?? undefined,
        TWILIO_WHATSAPP_FROM: Deno.env.get("TWILIO_WHATSAPP_FROM") ?? undefined,
      });
    } catch (err) {
      if (err instanceof MessagingError) {
        return errorJson(503, err.code, err.message);
      }
      throw err;
    }

    const db = serviceClient();
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;
    const { data: issueRows, error: issueError } = await db.rpc(
      "issue_otp_challenge",
      {
        p_restaurant_id: caller.restaurantId,
        p_user_id: caller.userId,
        p_phone: body.phone,
        p_channel: body.channel,
        p_purpose: "approve_po",
        p_reference_id: body.poId,
        p_code_hash: codeHash,
        p_salt: salt,
        p_expires_at: expiresAt,
        p_ip: ip,
        p_provider: provider.name,
      },
    );
    if (issueError) return internalError("otp-request", issueError);

    const issue = (issueRows as
      | Array<{
        outcome: string;
        challenge_id: string | null;
        retry_after_seconds: number | null;
      }>
      | null)?.[0];
    if (!issue) {
      return internalError(
        "otp-request",
        new Error("issue_otp_challenge returned no result"),
      );
    }
    if (issue.outcome !== "issued" || !issue.challenge_id) {
      return json(429, {
        error: "rate_limited",
        reason: issue.outcome,
        ...(issue.retry_after_seconds
          ? { retry_after_seconds: issue.retry_after_seconds }
          : {}),
      });
    }
    const challengeId = issue.challenge_id;

    try {
      const sent = await provider.send(
        body.phone,
        `Restamenu approval code for ${po.po_number}: ${code} (valid ${EXPIRY_MINUTES} min)`,
        body.channel,
      );
      const { error: messageIdError } = await db
        .from("otp_challenges")
        .update({ provider_message_id: sent.providerMessageId })
        .eq("id", challengeId);
      if (messageIdError) return internalError("otp-request", messageIdError);
    } catch (err) {
      // Challenge stays (cooldown burned by design); the caller may retry
      // after the cooldown or switch channels.
      console.error("[otp-request] provider send failed", err);
      return json(502, {
        error: "send_failed",
        message: "The verification code could not be delivered.",
      });
    }

    const { error: auditError } = await db.rpc("log_audit", {
      p_restaurant_id: caller.restaurantId,
      p_actor_id: caller.userId,
      p_actor_type: "otp",
      p_action: "otp.requested",
      p_entity_type: "purchase_order",
      p_entity_id: body.poId,
      p_detail: {
        channel: body.channel,
        provider: provider.name,
        po_number: po.po_number,
      },
    });
    if (auditError) return internalError("otp-request", auditError);

    return json(200, { challengeId, expiresAt, provider: provider.name });
  } catch (err) {
    return internalError("otp-request", err);
  }
});
