"use client";

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard render failed", error);
  }, [error]);

  return (
    <main className="page">
      <div className="card" role="alert" style={{ maxWidth: 640 }}>
        <h1 className="page-title" style={{ marginBottom: 8 }}>
          We couldn&apos;t load this page
        </h1>
        <p style={{ color: "var(--muted)", marginBottom: 16 }}>
          No changes were made. Retry the request; if it keeps failing, check
          the Supabase status and the server log using the error reference
          below.
        </p>
        {error.digest && (
          <p
            style={{
              color: "var(--muted)",
              fontFamily: "monospace",
              fontSize: 12,
              marginBottom: 16,
            }}
          >
            Reference: {error.digest}
          </p>
        )}
        <button type="button" className="btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
