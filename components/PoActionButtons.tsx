"use client";

import { useState, useTransition } from "react";
import { cancelOrder, pushOrderToXero } from "@/app/dashboard/orders/actions";

export function CancelOrderButton({ poId }: { poId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        className="btn-ghost"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await cancelOrder(poId);
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? "Cancelling…" : "Cancel draft"}
      </button>
      {error && <span style={{ color: "var(--danger)", fontSize: 12, marginLeft: 8 }}>{error}</span>}
    </span>
  );
}

export function PushToXeroButton({ poId, connected }: { poId: string; connected: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!connected) {
    return (
      <span style={{ color: "var(--muted)", fontSize: 12 }}>
        Connect Xero (Settings → Xero) to push this bill.
      </span>
    );
  }

  return (
    <span>
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await pushOrderToXero(poId);
            if (result.error) setError(result.error);
          })
        }
      >
        {pending ? "Pushing…" : "Push to Xero as bill"}
      </button>
      {error && <span style={{ color: "var(--danger)", fontSize: 12, marginLeft: 8 }}>{error}</span>}
    </span>
  );
}
