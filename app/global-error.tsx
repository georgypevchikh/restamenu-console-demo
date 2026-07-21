"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application error", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
          <h1 style={{ marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#666", marginBottom: 16 }}>
            An unexpected error occurred. Try again; if it persists, reload the
            page.
          </p>
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
