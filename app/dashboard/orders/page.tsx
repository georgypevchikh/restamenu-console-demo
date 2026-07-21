import Link from "next/link";
import { notFound } from "next/navigation";
import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import OrderForm, { type RequestForOrder } from "@/components/OrderForm";
import { formatMinor, formatDateTime } from "@/lib/format";
import type { PurchaseOrder } from "@/lib/types";

const PO_BADGE: Record<string, string> = {
  draft: "badge-pending",
  approved: "badge-bought",
  cancelled: "badge-cancelled",
};

export default async function OrdersPage() {
  const { supabase, active } = await requireRestaurantContext();
  if (active.role !== "manager") notFound();

  const { data: entitlement, error: entitlementError } = await supabase
    .from("entitlements")
    .select("active")
    .eq("restaurant_id", active.id)
    .eq("feature", "billing_pro")
    .maybeSingle();
  assertQuerySucceeded(entitlementError, "load the billing entitlement");
  const isPro = entitlement?.active ?? false;

  if (!isPro) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">Purchase Orders</h1>
        </div>
        <div className="card">
          <h2 style={{ fontSize: 15, marginBottom: 8 }}>Pro feature</h2>
          <p style={{ color: "var(--muted)", marginBottom: 12 }}>
            Purchase orders — with tax calculation, OTP approval, PDF documents
            and Xero sync — are part of the Pro plan. The gate is enforced in
            Postgres (<code>has_entitlement</code>), not just hidden in the UI.
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

  const [ordersResult, requestsResult, suppliersResult] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("*")
      .eq("restaurant_id", active.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("purchase_requests")
      .select(
        "id, quantity, product_id, products(name, unit, category_id, categories(name))",
      )
      .eq("restaurant_id", active.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    supabase.from("suppliers").select("product_id, price, is_primary"),
  ]);
  assertQuerySucceeded(ordersResult.error, "load purchase orders");
  assertQuerySucceeded(requestsResult.error, "load pending purchase requests");
  assertQuerySucceeded(suppliersResult.error, "load supplier prices");
  const orders = ordersResult.data;
  const pendingRequests = requestsResult.data;
  const suppliers = suppliersResult.data;

  const priceByProduct = new Map<string, number>();
  for (const s of suppliers ?? []) {
    if (
      s.price !== null &&
      (s.is_primary || !priceByProduct.has(s.product_id))
    ) {
      priceByProduct.set(s.product_id, Math.round(Number(s.price) * 100));
    }
  }

  const requestsForForm: RequestForOrder[] = (pendingRequests ?? []).map(
    (r) => {
      const productRaw = r.products;
      const product = (
        Array.isArray(productRaw) ? productRaw[0] : productRaw
      ) as {
        name: string;
        unit: string;
        categories?: { name: string } | { name: string }[] | null;
      } | null;
      const categoryRaw = product?.categories;
      const category = Array.isArray(categoryRaw)
        ? categoryRaw[0]
        : categoryRaw;
      return {
        id: r.id,
        quantity: Number(r.quantity),
        product_id: r.product_id,
        product_name: product?.name ?? "Unknown product",
        unit: product?.unit ?? "",
        category_name: category?.name ?? null,
        suggested_price_minor: priceByProduct.get(r.product_id) ?? null,
      };
    },
  );

  const orderRows = (orders ?? []) as PurchaseOrder[];

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Purchase Orders</h1>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Priced by the tax engine · approved with OTP · synced to Xero
        </span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>
          New order from pending requests
        </h2>
        <OrderForm requests={requestsForForm} />
      </div>

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Supplier</th>
                <th>Status</th>
                <th>Total</th>
                <th>Xero</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orderRows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--muted)" }}>
                    No purchase orders yet — create one above.
                  </td>
                </tr>
              )}
              {orderRows.map((po) => (
                <tr key={po.id}>
                  <td>
                    <Link href={`/dashboard/orders/${po.id}`}>
                      {po.po_number}
                    </Link>
                  </td>
                  <td>{po.supplier_name}</td>
                  <td>
                    <span className={`badge ${PO_BADGE[po.status]}`}>
                      {po.status}
                    </span>
                  </td>
                  <td>{formatMinor(po.total_minor, po.currency)}</td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>
                    {po.xero_invoice_id ? "pushed" : "—"}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>
                    {formatDateTime(po.created_at)}
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
