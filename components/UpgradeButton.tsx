"use client";

import { useState, useTransition } from "react";
import { startCheckout } from "@/app/dashboard/billing/actions";

export default function UpgradeButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await startCheckout();
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? "Opening Stripe…" : "Upgrade to Pro"}
      </button>
      {error && (
        <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{error}</p>
      )}
    </div>
  );
}
