import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseActiveRestaurant,
  type RestaurantChoice,
} from "../lib/restaurant-selection";

const memberships: RestaurantChoice[] = [
  { id: "bella", name: "Bella", region: "EU", role: "manager" },
  { id: "sakura", name: "Sakura", region: "EU", role: "team" },
];

describe("active restaurant selection", () => {
  it("honours only a restaurant present in the authenticated membership list", () => {
    expect(chooseActiveRestaurant(memberships, "sakura")?.id).toBe("sakura");
    expect(chooseActiveRestaurant(memberships, "attacker")?.id).toBe("bella");
    expect(chooseActiveRestaurant([], "bella")).toBeNull();
  });

  it("propagates the selected tenant to Edge Functions", () => {
    const bridge = readFileSync(resolve(process.cwd(), "lib/edge.ts"), "utf8");
    const resolver = readFileSync(
      resolve(process.cwd(), "supabase/functions/_shared/db.ts"),
      "utf8",
    );
    expect(bridge).toContain('"X-Restamenu-Restaurant-Id": context.active.id');
    expect(resolver).toContain('req.headers.get("x-restamenu-restaurant-id")');
    expect(resolver).toContain("active_restaurant_required");
  });

  it("does not leave the old ambiguous membership lookup in dashboard pages", () => {
    const pages = [
      "app/dashboard/layout.tsx",
      "app/dashboard/page.tsx",
      "app/dashboard/requests/page.tsx",
      "app/dashboard/orders/page.tsx",
      "app/dashboard/orders/[id]/page.tsx",
      "app/dashboard/billing/page.tsx",
      "app/dashboard/audit/page.tsx",
      "app/dashboard/settings/xero/page.tsx",
    ];
    for (const page of pages) {
      const source = readFileSync(resolve(process.cwd(), page), "utf8");
      expect(source, page).toContain("requireRestaurantContext");
      expect(source, page).not.toContain("membership.restaurant_id");
    }
  });

  it("does not redirect an authenticated account with no membership in a loop", () => {
    const contextSource = readFileSync(
      resolve(process.cwd(), "lib/current-restaurant.ts"),
      "utf8",
    );
    const middlewareSource = readFileSync(
      resolve(process.cwd(), "middleware.ts"),
      "utf8",
    );
    const emptyState = readFileSync(
      resolve(process.cwd(), "app/no-membership/page.tsx"),
      "utf8",
    );

    expect(contextSource).toContain(
      'redirect(user ? "/no-membership" : "/login")',
    );
    expect(middlewareSource).not.toContain(
      'pathname === "/no-membership"',
    );
    expect(emptyState).toContain('action="/api/auth/signout"');
  });
});
