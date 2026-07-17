"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface NavBarProps {
  restaurantName: string;
  restaurantRegion: string;
  role: string;
  userEmail: string;
}

export default function NavBar({ restaurantName, restaurantRegion, role, userEmail }: NavBarProps) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

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
        <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
