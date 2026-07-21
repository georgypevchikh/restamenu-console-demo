"use client";

import { useState, useTransition } from "react";
import { connectXero, importBills } from "@/app/dashboard/settings/xero/actions";

export function ConnectXeroButton({ connected }: { connected: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        className={connected ? "btn-ghost" : "btn-primary"}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await connectXero();
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? "Redirecting…" : connected ? "Reconnect" : "Connect Xero demo company"}
      </button>
      {error && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{error}</p>}
    </div>
  );
}

export function ImportBillsButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
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
            setMessage(null);
            const result = await importBills();
            if (result.error) setError(result.error);
            else setMessage(`Imported ${result.imported} bill${result.imported === 1 ? "" : "s"}.`);
          })
        }
      >
        {pending ? "Importing…" : "Import bills from Xero"}
      </button>
      {message && <p style={{ color: "var(--success)", fontSize: 12, marginTop: 8 }}>{message}</p>}
      {error && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{error}</p>}
    </div>
  );
}
