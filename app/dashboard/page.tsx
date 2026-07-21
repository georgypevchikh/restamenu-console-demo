import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import ProductTable from "@/components/ProductTable";
import type { Product } from "@/lib/types";

export default async function DashboardPage() {
  const { supabase, active } = await requireRestaurantContext();

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("*, categories(name, icon)")
    .eq("restaurant_id", active.id)
    .eq("is_active", true)
    .order("name");
  assertQuerySucceeded(productsError, "load products");

  const { data: pendingRequests, error: pendingRequestsError } = await supabase
    .from("purchase_requests")
    .select("id")
    .eq("restaurant_id", active.id)
    .eq("status", "pending");
  assertQuerySucceeded(pendingRequestsError, "load pending requests");

  const { data: urgentRequests, error: urgentRequestsError } = await supabase
    .from("purchase_requests")
    .select("id")
    .eq("restaurant_id", active.id)
    .eq("priority", "urgent")
    .eq("status", "pending");
  assertQuerySucceeded(urgentRequestsError, "load urgent requests");

  const lowStock = (products ?? []).filter(
    (p) => p.current_stock !== null && p.current_stock <= p.min_quantity,
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Products</h1>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          RLS: only your restaurant&apos;s rows are returned by Postgres
        </span>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Total products</div>
          <div className="stat-value">{products?.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Low stock</div>
          <div
            className="stat-value"
            style={{
              color: lowStock.length > 0 ? "var(--warning)" : undefined,
            }}
          >
            {lowStock.length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pending requests</div>
          <div className="stat-value">{pendingRequests?.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Urgent</div>
          <div
            className="stat-value"
            style={{
              color:
                (urgentRequests?.length ?? 0) > 0 ? "var(--danger)" : undefined,
            }}
          >
            {urgentRequests?.length ?? 0}
          </div>
        </div>
      </div>

      <div className="card">
        <ProductTable products={(products ?? []) as Product[]} />
      </div>
    </div>
  );
}
