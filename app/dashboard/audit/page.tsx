import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import type { AuditEvent, OutboxEvent } from "@/lib/types";

const ACTOR_COLORS: Record<string, string> = {
  user: "var(--accent)",
  stripe: "#635bff",
  xero: "#13b5ea",
  otp: "var(--warning)",
  system: "var(--muted)",
  outbox: "var(--muted)",
};

const OUTBOX_BADGE: Record<string, { bg: string; color: string }> = {
  pending: { bg: "rgba(245,158,11,0.15)", color: "var(--warning)" },
  delivering: { bg: "rgba(99,102,241,0.15)", color: "var(--accent)" },
  delivered: { bg: "rgba(16,185,129,0.15)", color: "var(--success)" },
  failed: { bg: "rgba(239,68,68,0.15)", color: "var(--danger)" },
};

export default async function AuditPage() {
  const { supabase, active } = await requireRestaurantContext();
  if (active.role !== "manager") notFound();

  const [auditResult, outboxResult] = await Promise.all([
    supabase
      .from("audit_events")
      .select("*")
      .eq("restaurant_id", active.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("outbox_events")
      .select("*")
      .eq("restaurant_id", active.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  assertQuerySucceeded(auditResult.error, "load the audit timeline");
  assertQuerySucceeded(outboxResult.error, "load outbox deliveries");
  const audit = auditResult.data;
  const outbox = outboxResult.data;

  const auditRows = (audit ?? []) as AuditEvent[];
  const outboxRows = (outbox ?? []) as OutboxEvent[];

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Audit</h1>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Every domain transition + outbox delivery state, tenant-scoped by RLS
        </span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Timeline</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Actor</th>
                <th>Action</th>
                <th>Detail</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--muted)" }}>
                    No events yet.
                  </td>
                </tr>
              )}
              {auditRows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        color: ACTOR_COLORS[e.actor_type] ?? "var(--muted)",
                      }}
                    >
                      {e.actor_type}
                    </span>
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {e.action}
                  </td>
                  <td
                    style={{
                      color: "var(--muted)",
                      fontSize: 11,
                      fontFamily: "monospace",
                    }}
                  >
                    {JSON.stringify(e.detail).slice(0, 120)}
                  </td>
                  <td
                    style={{
                      color: "var(--muted)",
                      fontSize: 12,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatDateTime(e.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 15, marginBottom: 4 }}>
          Outbox deliveries
          <span
            style={{ color: "var(--muted)", fontSize: 12, fontWeight: 400 }}
          >
            {" "}
            · transactional outbox → pg_cron → pg_net → n8n, with retries and
            backoff
          </span>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Created</th>
                <th>Delivered</th>
              </tr>
            </thead>
            <tbody>
              {outboxRows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--muted)" }}>
                    No outbox events yet.
                  </td>
                </tr>
              )}
              {outboxRows.map((e) => {
                const badge = OUTBOX_BADGE[e.status];
                return (
                  <tr key={e.id}>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                      {e.event_type}
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{ background: badge.bg, color: badge.color }}
                      >
                        {e.status}
                      </span>
                    </td>
                    <td>
                      {e.attempts}/{e.max_attempts}
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 11 }}>
                      {e.last_error ?? "—"}
                    </td>
                    <td
                      style={{
                        color: "var(--muted)",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatDateTime(e.created_at)}
                    </td>
                    <td
                      style={{
                        color: "var(--muted)",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.delivered_at ? formatDateTime(e.delivered_at) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
