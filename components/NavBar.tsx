"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { switchRestaurant } from "@/app/dashboard/actions";
import type { RestaurantChoice } from "@/lib/restaurant-selection";

interface NavBarProps {
  restaurantName: string;
  restaurantRegion: string;
  role: string;
  userEmail: string;
  restaurantId: string;
  restaurants: RestaurantChoice[];
}

export default function NavBar({
  restaurantName,
  restaurantRegion,
  role,
  userEmail,
  restaurantId,
  restaurants,
}: NavBarProps) {
  const pathname = usePathname();

  return (
    <nav className="nav">
      <span className="nav-brand">🍽️ Restamenu</span>
      {restaurants.length > 1 ? (
        <form action={switchRestaurant} className="tenant-badge">
          <select
            name="restaurant_id"
            defaultValue={restaurantId}
            aria-label="Active restaurant"
          >
            {restaurants.map((restaurant) => (
              <option key={restaurant.id} value={restaurant.id}>
                {restaurant.name} · {restaurant.region} · {restaurant.role}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-ghost">
            Switch
          </button>
        </form>
      ) : (
        <span className="tenant-badge">
          {restaurantName} · {restaurantRegion} · {role}
        </span>
      )}
      <div className="nav-links">
        <Link
          href="/dashboard"
          className={pathname === "/dashboard" ? "active" : ""}
        >
          Products
        </Link>
        <Link
          href="/dashboard/requests"
          className={pathname === "/dashboard/requests" ? "active" : ""}
        >
          Requests
        </Link>
        {role === "manager" && (
          <>
            <Link
              href="/dashboard/orders"
              className={
                pathname.startsWith("/dashboard/orders") ? "active" : ""
              }
            >
              Orders
            </Link>
            <Link
              href="/dashboard/billing"
              className={pathname === "/dashboard/billing" ? "active" : ""}
            >
              Billing
            </Link>
            <Link
              href="/dashboard/audit"
              className={pathname === "/dashboard/audit" ? "active" : ""}
            >
              Audit
            </Link>
            <Link
              href="/dashboard/settings/xero"
              className={
                pathname === "/dashboard/settings/xero" ? "active" : ""
              }
            >
              Xero
            </Link>
          </>
        )}
        <span className="nav-email" style={{ color: "var(--border)" }}>
          |
        </span>
        <span
          className="nav-email"
          style={{ color: "var(--muted)", fontSize: 12 }}
        >
          {userEmail}
        </span>
        <form
          action="/api/auth/signout"
          method="POST"
          style={{ display: "contents" }}
        >
          <button
            type="submit"
            className="btn-ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
          >
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
