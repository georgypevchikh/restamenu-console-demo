"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const DEMO_ACCOUNTS = [
  { label: "🍕 Bella Italia — Manager", email: "manager@bella-italia.demo", role: "Manager", restaurant: "Bella Italia" },
  { label: "🍕 Bella Italia — Staff", email: "staff@bella-italia.demo", role: "Staff", restaurant: "Bella Italia" },
  { label: "🍣 Sakura House — Manager", email: "manager@sakura-house.demo", role: "Manager", restaurant: "Sakura House" },
  { label: "🍣 Sakura House — Staff", email: "staff@sakura-house.demo", role: "Staff", restaurant: "Sakura House" },
];

const DEMO_PASSWORD = "demo1234";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  function fillDemo(account: typeof DEMO_ACCOUNTS[0]) {
    setEmail(account.email);
    setPassword(DEMO_PASSWORD);
    setError(null);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🍽️</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Restamenu Console</h1>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Multi-tenant demo — RLS keeps each restaurant's data isolated
          </p>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Demo accounts — click to fill
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.email}
                className="btn-ghost"
                style={{ textAlign: "left", fontSize: 12, padding: "8px 10px" }}
                onClick={() => fillDemo(acc)}
              >
                {acc.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>
            Password: <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 6px", borderRadius: 4 }}>{DEMO_PASSWORD}</code>
          </p>
        </div>

        <form onSubmit={handleLogin} className="card">
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="manager@bella-italia.demo"
              required
              autoComplete="email"
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </div>
          {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}
          <button className="btn-primary" type="submit" disabled={loading} style={{ width: "100%" }}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: "var(--muted)" }}>
          Built by{" "}
          <a href="https://github.com/georgypevchikh" target="_blank" rel="noopener noreferrer">
            @georgypevchikh
          </a>{" "}
          · RLS isolates tenants at DB level, not application layer
        </p>
      </div>
    </div>
  );
}
