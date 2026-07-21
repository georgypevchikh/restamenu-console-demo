import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertQuerySucceeded } from "../lib/supabase/query";

describe("dashboard query failures", () => {
  it("throws a stable client-safe error while logging the server diagnostic", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      assertQuerySucceeded(
        {
          code: "XX000",
          message: "sensitive database detail",
          details: "internal relation name",
        },
        "load billing state",
      ),
    ).toThrow("Could not load billing state. Please try again.");

    expect(log).toHaveBeenCalledWith(
      "Supabase query failed",
      expect.objectContaining({
        code: "XX000",
        message: "sensitive database detail",
      }),
    );
    log.mockRestore();
  });

  it("guards every dashboard data page instead of rendering query errors as empty state", () => {
    const guardedPages = [
      "app/dashboard/layout.tsx",
      "app/dashboard/page.tsx",
      "app/dashboard/requests/page.tsx",
      "app/dashboard/orders/page.tsx",
      "app/dashboard/orders/[id]/page.tsx",
      "app/dashboard/billing/page.tsx",
      "app/dashboard/audit/page.tsx",
      "app/dashboard/settings/xero/page.tsx",
    ];

    for (const page of guardedPages) {
      const source = readFileSync(resolve(process.cwd(), page), "utf8");
      expect(source, page).toMatch(
        /assertQuerySucceeded|requireRestaurantContext/,
      );
      expect(source, page).not.toMatch(/const\s+\[\s*\{\s*data:/);
    }
  });
});
