import { assertQuerySucceeded } from "@/lib/supabase/query";
import { requireRestaurantContext } from "@/lib/current-restaurant";
import { notFound } from "next/navigation";
import UpgradeButton from "@/components/UpgradeButton";
import { formatDate } from "@/lib/format";
import type { Subscription, Entitlement } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  active: "var(--success)",
  trialing: "var(--success)",
  past_due: "var(--warning)",
  canceled: "var(--danger)",
  unpaid: "var(--danger)",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { supabase, active } = await requireRestaurantContext();
  if (active.role !== "manager") notFound();

  const [subscriptionsResult, entitlementsResult] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("*")
      .eq("restaurant_id", active.id)
      .order("updated_at", { ascending: false }),
    supabase.from("entitlements").select("*").eq("restaurant_id", active.id),
  ]);
  assertQuerySucceeded(subscriptionsResult.error, "load subscriptions");
  assertQuerySucceeded(entitlementsResult.error, "load entitlements");
  const subscriptions = subscriptionsResult.data;
  const entitlements = entitlementsResult.data;

  const subscription = (subscriptions ?? [])[0] as Subscription | undefined;
  const pro = ((entitlements ?? []) as Entitlement[]).find(
    (e) => e.feature === "billing_pro",
  );
  const isPro = pro?.active ?? false;
  const { checkout } = await searchParams;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Billing</h1>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Stripe test mode · entitlements enforced in Postgres
        </span>
      </div>

      {checkout === "success" && (
        <div
          className="card"
          style={{ marginBottom: 16, borderColor: "var(--success)" }}
        >
          Checkout completed. The webhook activates the subscription — this page
          reflects it within a few seconds (refresh if needed).
        </div>
      )}
      {checkout === "cancelled" && (
        <div
          className="card"
          style={{ marginBottom: 16, borderColor: "var(--warning)" }}
        >
          Checkout was cancelled — no changes were made.
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Plan</div>
          <div className="stat-value">{isPro ? "Pro" : "Free"}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Subscription</div>
          <div
            className="stat-value"
            style={{
              color: subscription
                ? STATUS_COLORS[subscription.status]
                : undefined,
              fontSize: 20,
            }}
          >
            {subscription?.status ?? "none"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Renews</div>
          <div className="stat-value" style={{ fontSize: 20 }}>
            {formatDate(subscription?.current_period_end ?? null)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pro features</div>
          <div
            className="stat-value"
            style={{
              color: isPro ? "var(--success)" : "var(--muted)",
              fontSize: 20,
            }}
          >
            {isPro ? "unlocked" : "locked"}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Pro plan</h2>
        <p style={{ color: "var(--muted)", marginBottom: 12 }}>
          Purchase orders with versioned tax calculation, OTP-gated approvals,
          PDF documents, Xero sync and the audit timeline. Subscription state
          arrives via signed Stripe webhooks; access is granted and revoked by a
          database trigger, in the same transaction.
        </p>

        {isPro ? (
          <p style={{ color: "var(--success)", fontSize: 13 }}>
            ✓ Active{pro?.source ? ` — ${pro.source}` : ""}
          </p>
        ) : (
          <>
            <UpgradeButton />
            <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
              Test card: 4242 4242 4242 4242 · any future expiry · any CVC. No
              real money moves in test mode.
            </p>
          </>
        )}
      </div>

      {subscription && (
        <div className="card">
          <h2 style={{ fontSize: 15, marginBottom: 8 }}>Subscription record</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Stripe id</th>
                  <th>Status</th>
                  <th>Cancel at period end</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {subscription.stripe_subscription_id}
                  </td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        color:
                          STATUS_COLORS[subscription.status] ?? "var(--muted)",
                      }}
                    >
                      {subscription.status}
                    </span>
                  </td>
                  <td>{subscription.cancel_at_period_end ? "yes" : "no"}</td>
                  <td>{formatDate(subscription.updated_at)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
