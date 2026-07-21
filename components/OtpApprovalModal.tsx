"use client";

import { useState, useTransition } from "react";
import { requestOtp, verifyOtpAndApprove } from "@/app/dashboard/orders/actions";

/**
 * Two-step OTP approval: request a code to a phone (SMS or WhatsApp), then
 * verify it. Verification and the actual approval are separate calls — the
 * otp-verify function stamps the challenge, approve_purchase_order consumes
 * it transactionally in Postgres.
 */
export default function OtpApprovalModal({ poId, poNumber }: { poId: string; poNumber: string }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<"sms" | "whatsapp">("sms");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setOpen(false);
    setStep("phone");
    setCode("");
    setChallengeId(null);
    setError(null);
  }

  function sendCode() {
    setError(null);
    startTransition(async () => {
      const result = await requestOtp(poId, phone, channel);
      if (result.error) {
        setError(result.error);
        return;
      }
      setChallengeId(result.challengeId!);
      setProvider(result.provider ?? null);
      setStep("code");
    });
  }

  function verify() {
    setError(null);
    startTransition(async () => {
      const result = await verifyOtpAndApprove(poId, challengeId!, code);
      if (result.error) {
        setError(result.error);
        return;
      }
      reset(); // page revalidates; the PO now shows as approved
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        Approve with OTP…
      </button>
    );
  }

  return (
    <div className="card" style={{ borderColor: "var(--accent)", maxWidth: 420 }}>
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>Approve {poNumber}</h3>

      {step === "phone" && (
        <>
          <div className="field" style={{ marginBottom: 10 }}>
            <label className="field-label" htmlFor="otp-phone">Phone (E.164)</label>
            <input
              id="otp-phone"
              placeholder="+37060000000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label className="field-label" htmlFor="otp-channel">Channel</label>
            <select
              id="otp-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as "sms" | "whatsapp")}
            >
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-primary" onClick={sendCode} disabled={pending || !phone}>
              {pending ? "Sending…" : "Send code"}
            </button>
            <button type="button" className="btn-ghost" onClick={reset} disabled={pending}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "code" && (
        <>
          <p style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
            Code sent via {channel}
            {provider === "console" && (
              <> — <strong>console provider</strong>: the code is in the Edge Function logs, not on your phone (Twilio not configured yet)</>
            )}
            . Valid for 5 minutes, 5 attempts.
          </p>
          <div className="field" style={{ marginBottom: 12 }}>
            <label className="field-label" htmlFor="otp-code">6-digit code</label>
            <input
              id="otp-code"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn-primary"
              onClick={verify}
              disabled={pending || code.length !== 6}
            >
              {pending ? "Verifying…" : "Verify & approve"}
            </button>
            <button type="button" className="btn-ghost" onClick={reset} disabled={pending}>
              Cancel
            </button>
          </div>
        </>
      )}

      {error && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>{error}</p>}
    </div>
  );
}
