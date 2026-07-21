import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import RequestTable from "@/components/RequestTable";
import NewRequestForm from "@/components/NewRequestForm";
import type { PurchaseRequest, Product } from "@/lib/types";

export default async function RequestsPage() {
  const { supabase, active, user } = await requireRestaurantContext();

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, unit")
    .eq("restaurant_id", active.id)
    .eq("is_active", true)
    .order("name");
  assertQuerySucceeded(productsError, "load requestable products");

  let requestsQuery = supabase
    .from("purchase_requests")
    .select("*, products(name, unit), profiles(full_name)")
    .eq("restaurant_id", active.id);
  if (active.role !== "manager") {
    requestsQuery = requestsQuery.eq("created_by", user.id);
  }
  const { data: requests, error: requestsError } = await requestsQuery
    .order("created_at", { ascending: false })
    .limit(50);
  assertQuerySucceeded(requestsError, "load purchase requests");

  const byStatus = {
    pending: (requests ?? []).filter((r) => r.status === "pending").length,
    bought: (requests ?? []).filter((r) => r.status === "bought").length,
    urgent: (requests ?? []).filter(
      (r) => r.priority === "urgent" && r.status === "pending",
    ).length,
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Purchase Requests</h1>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Latest 50 · tenant-isolated via RLS
        </span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <NewRequestForm products={(products ?? []) as Product[]} />
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value">{requests?.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pending</div>
          <div
            className="stat-value"
            style={{
              color: byStatus.pending > 0 ? "var(--warning)" : undefined,
            }}
          >
            {byStatus.pending}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Urgent</div>
          <div
            className="stat-value"
            style={{ color: byStatus.urgent > 0 ? "var(--danger)" : undefined }}
          >
            {byStatus.urgent}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Bought</div>
          <div className="stat-value" style={{ color: "var(--success)" }}>
            {byStatus.bought}
          </div>
        </div>
      </div>

      <div className="card">
        <RequestTable requests={(requests ?? []) as PurchaseRequest[]} />
      </div>
    </div>
  );
}
