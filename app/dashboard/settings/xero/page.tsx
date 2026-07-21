import Link from "next/link";
import { notFound } from "next/navigation";
import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import {
  ConnectXeroButton,
  ImportBillsButton,
} from "@/components/XeroControls";
import { formatDate, formatDateTime } from "@/lib/format";
import type { XeroSyncLogEntry, XeroBill } from "@/lib/types";

export default async function XeroSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; xero_error?: string }>;
}) {
  const { supabase, active } = await requireRestaurantContext();
  if (active.role !== "manager") notFound();

  const { data: entitlement, error: entitlementError } = await supabase
    .from("entitlements")
    .select("active")
    .eq("restaurant_id", active.id)
    .eq("feature", "billing_pro")
    .maybeSingle();
  assertQuerySucceeded(entitlementError, "load the billing entitlement");

  if (!entitlement?.active) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">Xero</h1>
        </div>
        <div className="card">
          <p style={{ color: "var(--muted)", marginBottom: 12 }}>
            Xero sync is a Pro feature.
          </p>
          <Link
            href="/dashboard/billing"
            className="btn-primary"
            style={{ display: "inline-block" }}
          >
            Go to Billing
          </Link>
        </div>
      </div>
    );
  }

  const [statusResult, syncLogResult, billsResult] = await Promise.all([
    supabase.rpc("xero_connection_status", {
      p_restaurant_id: active.id,
    }),
    supabase
      .from("xero_sync_log")
      .select("*")
      .eq("restaurant_id", active.id)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("xero_bills")
      .select("*")
      .eq("restaurant_id", active.id)
      .order("date", { ascending: false })
      .limit(25),
  ]);
  assertQuerySucceeded(statusResult.error, "load the Xero connection status");
  assertQuerySucceeded(syncLogResult.error, "load the Xero sync journal");
  assertQuerySucceeded(billsResult.error, "load imported Xero bills");
  const statusRows = statusResult.data;
  const syncLog = syncLogResult.data;
  const bills = billsResult.data;

  const status =
    Array.isArray(statusRows) && statusRows.length > 0 ? statusRows[0] : null;
  const connected = status?.connected === true;
  const { connected: justConnected, xero_error: xeroError } =
    await searchParams;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Xero</h1>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          OAuth 2.0 · demo company · tokens encrypted at rest
        </span>
      </div>

      {justConnected === "1" && (
        <div
          className="card"
          style={{ marginBottom: 16, borderColor: "var(--success)" }}
        >
          Connected to Xero. Tokens are stored encrypted; only the Edge
          Functions can read them.
        </div>
      )}
      {xeroError && (
        <div
          className="card"
          style={{ marginBottom: 16, borderColor: "var(--danger)" }}
        >
          Xero connection failed: <code>{xeroError}</code>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Connection</h2>
        {connected ? (
          <p style={{ marginBottom: 12 }}>
            <span style={{ color: "var(--success)" }}>✓ Connected</span>
            {status?.tenant_name && (
              <>
                {" "}
                to <strong>{status.tenant_name}</strong>
              </>
            )}
            {status?.access_expires_at && (
              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                {" "}
                · access token refreshes automatically (expires{" "}
                {formatDateTime(status.access_expires_at)})
              </span>
            )}
          </p>
        ) : (
          <p style={{ color: "var(--muted)", marginBottom: 12 }}>
            Not connected
            {status?.status && status.status !== "connected"
              ? ` (${status.status})`
              : ""}
            . Connecting links this restaurant to a Xero <em>demo company</em> —
            approved purchase orders can then be pushed as draft bills, and
            bills can be imported back.
          </p>
        )}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <ConnectXeroButton connected={connected} />
          {connected && <ImportBillsButton />}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>
          Imported bills
          <span
            style={{ color: "var(--muted)", fontSize: 12, fontWeight: 400 }}
          >
            {" "}
            · ACCPAY mirror
          </span>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>Status</th>
                <th>Date</th>
                <th>Due</th>
                <th>Total</th>
                <th>Imported</th>
              </tr>
            </thead>
            <tbody>
              {(bills ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--muted)" }}>
                    Nothing imported yet.
                  </td>
                </tr>
              )}
              {((bills ?? []) as XeroBill[]).map((b) => (
                <tr key={b.id}>
                  <td>{b.contact_name ?? "—"}</td>
                  <td>{b.xero_status ?? "—"}</td>
                  <td>{formatDate(b.date)}</td>
                  <td>{formatDate(b.due_date)}</td>
                  <td>
                    {b.total !== null
                      ? `${Number(b.total).toFixed(2)} ${b.currency ?? ""}`
                      : "—"}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>
                    {formatDateTime(b.imported_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>
          Sync journal
          <span
            style={{ color: "var(--muted)", fontSize: 12, fontWeight: 400 }}
          >
            {" "}
            · every push, pull and token refresh — success or failure
          </span>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Direction</th>
                <th>Status</th>
                <th>Detail</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {(syncLog ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} style={{ color: "var(--muted)" }}>
                    No sync activity yet.
                  </td>
                </tr>
              )}
              {((syncLog ?? []) as XeroSyncLogEntry[]).map((entry) => (
                <tr key={entry.id}>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {entry.operation}
                  </td>
                  <td>{entry.direction}</td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background:
                          entry.status === "success"
                            ? "rgba(16,185,129,0.15)"
                            : "rgba(239,68,68,0.15)",
                        color:
                          entry.status === "success"
                            ? "var(--success)"
                            : "var(--danger)",
                      }}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>
                    {entry.error ?? JSON.stringify(entry.summary)}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>
                    {formatDateTime(entry.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
