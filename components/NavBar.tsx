"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavBarProps {
  restaurantName: string;
  restaurantRegion: string;
  role: string;
  userEmail: string;
}

export default function NavBar({ restaurantName, restaurantRegion, role, userEmail }: NavBarProps) {
  const pathname = usePathname();

  return (
    <nav className="nav">
      <span className="nav-brand">🍽️ Restamenu</span>
      <span className="tenant-badge">
        {restaurantName} · {restaurantRegion} · {role}
      </span>
      <div className="nav-links">
        <Link href="/dashboard" className={pathname === "/dashboard" ? "active" : ""}>
          Products
        </Link>
        <Link href="/dashboard/requests" className={pathname === "/dashboard/requests" ? "active" : ""}>
          Requests
        </Link>
        <span style={{ color: "var(--border)" }}>|</span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{userEmail}</span>
        <form action="/api/auth/signout" method="POST" style={{ display: "contents" }}>
          <button type="submit" className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
