import type { PurchaseRequest } from "@/lib/types";

interface Props {
  requests: PurchaseRequest[];
}

const PRIORITY_BADGE: Record<string, string> = {
  urgent: "badge-urgent",
  normal: "badge-normal",
  whenever: "badge-cancelled",
  by_breakfast: "badge-normal",
  by_lunch: "badge-normal",
  by_dinner: "badge-normal",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-pending",
  bought: "badge-bought",
  not_found: "badge-urgent",
  partial: "badge-normal",
  cancelled: "badge-cancelled",
};

export default function RequestTable({ requests }: Props) {
  if (requests.length === 0) {
    return <div className="empty">No purchase requests yet.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Qty</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Requested by</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        {requests.map((r) => (
          <tr key={r.id}>
            <td style={{ fontWeight: 500 }}>
              {r.products?.name ?? "—"}
              {r.products?.unit && (
                <span style={{ color: "var(--muted)", fontWeight: 400, marginLeft: 4 }}>
                  ({r.products.unit})
                </span>
              )}
            </td>
            <td>{r.quantity}</td>
            <td>
              <span className={`badge ${PRIORITY_BADGE[r.priority] ?? "badge-normal"}`}>
                {r.priority.replace(/_/g, " ")}
              </span>
            </td>
            <td>
              <span className={`badge ${STATUS_BADGE[r.status] ?? "badge-pending"}`}>
                {r.status.replace(/_/g, " ")}
              </span>
            </td>
            <td style={{ color: "var(--muted)" }}>{r.profiles?.full_name ?? "—"}</td>
            <td style={{ color: "var(--muted)", fontSize: 12 }}>
              {new Date(r.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
