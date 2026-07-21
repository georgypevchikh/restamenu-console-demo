import Link from "next/link";
import { notFound } from "next/navigation";
import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import OtpApprovalModal from "@/components/OtpApprovalModal";
import {
  CancelOrderButton,
  PushToXeroButton,
} from "@/components/PoActionButtons";
import { formatMinor, formatDateTime } from "@/lib/format";
import type { PurchaseOrder, PurchaseOrderLine } from "@/lib/types";

const PO_BADGE: Record<string, string> = {
  draft: "badge-pending",
  approved: "badge-bought",
  cancelled: "badge-cancelled",
};

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, active } = await requireRestaurantContext();
  if (active.role !== "manager") notFound();

  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .select("*, profiles:approved_by(full_name)")
    .eq("id", id)
    .eq("restaurant_id", active.id)
    .maybeSingle();
  assertQuerySucceeded(poError, "load the purchase order");
  if (!po) notFound();

  const order = po as PurchaseOrder;

  const [linesResult, calculationResult, xeroStatusResult] = await Promise.all([
    supabase
      .from("purchase_order_lines")
      .select("*")
      .eq("purchase_order_id", id)
      .order("description"),
    order.tax_calculation_id
      ? supabase
          .from("tax_calculations")
          .select("rule_set_version, trace, calculated_at")
          .eq("id", order.tax_calculation_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.rpc("xero_connection_status", {
      p_restaurant_id: active.id,
    }),
  ]);
  assertQuerySucceeded(linesResult.error, "load the purchase-order lines");
  assertQuerySucceeded(
    calculationResult.error,
    "load the tax calculation trace",
  );
  assertQuerySucceeded(
    xeroStatusResult.error,
    "load the Xero connection status",
  );
  const lines = linesResult.data;
  const calc = calculationResult.data;
  const xeroStatus = xeroStatusResult.data;

  const lineRows = (lines ?? []) as PurchaseOrderLine[];
  const xeroConnected =
    Array.isArray(xeroStatus) &&
    xeroStatus.length > 0 &&
    xeroStatus[0].connected === true;
  const trace = (calc?.trace ?? []) as Array<{
    step: string;
    detail: Record<string, unknown>;
  }>;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">
          {order.po_number}{" "}
          <span
            className={`badge ${PO_BADGE[order.status]}`}
            style={{ verticalAlign: "middle" }}
          >
            {order.status}
          </span>
        </h1>
        <Link href="/dashboard/orders" style={{ fontSize: 13 }}>
          ← All orders
        </Link>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Supplier</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {order.supplier_name}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Subtotal</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {formatMinor(order.subtotal_minor, order.currency)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Tax{order.withholding_minor > 0 ? " / withholding" : ""}
          </div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {formatMinor(order.tax_total_minor, order.currency)}
            {order.withholding_minor > 0 && (
              <span style={{ color: "var(--warning)" }}>
                {" "}
                −{formatMinor(order.withholding_minor, order.currency)}
              </span>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {formatMinor(order.total_minor, order.currency)}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Category</th>
                <th>Qty</th>
                <th>Unit price</th>
                <th>Tax</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {lineRows.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td style={{ color: "var(--muted)" }}>
                    {l.category_name ?? "—"}
                  </td>
                  <td>
                    {Number(l.quantity)} {l.unit}
                  </td>
                  <td>{formatMinor(l.unit_price_minor, order.currency)}</td>
                  <td>
                    {formatMinor(l.tax_minor, order.currency)}
                    {l.tax_detail && (
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>
                        {" "}
                        ({(l.tax_detail.rate_bps / 100).toFixed(1)}%{" "}
                        {l.tax_detail.rule_name})
                      </span>
                    )}
                  </td>
                  <td>{formatMinor(l.line_total_minor, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Actions</h2>
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {order.status === "draft" && (
            <>
              <OtpApprovalModal poId={order.id} poNumber={order.po_number} />
              <CancelOrderButton poId={order.id} />
            </>
          )}
          {order.status === "approved" && (
            <>
              <a
                href={`/api/po/${order.id}/pdf`}
                className="btn-ghost"
                style={{ display: "inline-block" }}
              >
                Download PDF
              </a>
              {!order.xero_invoice_id && (
                <PushToXeroButton poId={order.id} connected={xeroConnected} />
              )}
              {order.xero_invoice_id && (
                <span style={{ color: "var(--success)", fontSize: 13 }}>
                  ✓ In Xero as draft bill{" "}
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {order.xero_invoice_id}
                  </span>
                </span>
              )}
            </>
          )}
        </div>
        {order.approved_at && (
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
            Approved {formatDateTime(order.approved_at)}
            {order.profiles?.full_name
              ? ` by ${order.profiles.full_name}`
              : ""}{" "}
            (OTP-verified)
          </p>
        )}
      </div>

      {trace.length > 0 && (
        <div className="card">
          <h2 style={{ fontSize: 15, marginBottom: 4 }}>
            Calculation trace
            <span
              style={{ color: "var(--muted)", fontSize: 12, fontWeight: 400 }}
            >
              {" "}
              · rule set v{calc?.rule_set_version} · immutable record of how
              this document was priced
            </span>
          </h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 200 }}>Step</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {trace.map((step, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                      {step.step}
                    </td>
                    <td
                      style={{
                        fontFamily: "monospace",
                        fontSize: 11,
                        color: "var(--muted)",
                      }}
                    >
                      {JSON.stringify(step.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
