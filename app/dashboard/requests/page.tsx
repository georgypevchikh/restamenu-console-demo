import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RequestTable from "@/components/RequestTable";
import NewRequestForm from "@/components/NewRequestForm";
import type { PurchaseRequest, Product } from "@/lib/types";

export default async function RequestsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("restaurant_members")
    .select("role, restaurant_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) redirect("/login");

  const { data: products } = await supabase
    .from("products")
    .select("id, name, unit")
    .eq("restaurant_id", membership.restaurant_id)
    .eq("is_active", true)
    .order("name");

  const { data: requests } = await supabase
    .from("purchase_requests")
    .select("*, products(name, unit), profiles(full_name)")
    .eq("restaurant_id", membership.restaurant_id)
    .order("created_at", { ascending: false })
    .limit(50);

  const byStatus = {
    pending: (requests ?? []).filter((r) => r.status === "pending").length,
    bought: (requests ?? []).filter((r) => r.status === "bought").length,
    urgent: (requests ?? []).filter((r) => r.priority === "urgent" && r.status === "pending").length,
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
          <div className="stat-value" style={{ color: byStatus.pending > 0 ? "var(--warning)" : undefined }}>
            {byStatus.pending}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Urgent</div>
          <div className="stat-value" style={{ color: byStatus.urgent > 0 ? "var(--danger)" : undefined }}>
            {byStatus.urgent}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Bought</div>
          <div className="stat-value" style={{ color: "var(--success)" }}>{byStatus.bought}</div>
        </div>
      </div>

      <div className="card">
        <RequestTable requests={(requests ?? []) as PurchaseRequest[]} role={membership.role} />
      </div>
    </div>
  );
}
