import { describe, expect, it } from "vitest";
import {
  checkoutReturnUrls,
  stripeCustomerIdempotencyKey,
} from "../supabase/functions/_shared/core/stripe-checkout.ts";

describe("Stripe Checkout configuration", () => {
  it("derives both return URLs from the configured application origin", () => {
    expect(checkoutReturnUrls("https://console.example.com/")).toEqual({
      successUrl: "https://console.example.com/dashboard/billing?checkout=success",
      cancelUrl: "https://console.example.com/dashboard/billing?checkout=cancelled",
    });
    expect(checkoutReturnUrls("http://localhost:3000").successUrl).toMatch(
      /^http:\/\/localhost:3000\//,
    );
  });

  it.each([
    "not a URL",
    "http://console.example.com",
    "https://user:pass@console.example.com",
    "https://console.example.com/evil",
    "https://console.example.com/?next=https://evil.example",
    "javascript:alert(1)",
  ])("rejects a non-origin or unsafe APP_BASE_URL: %s", (value) => {
    expect(() => checkoutReturnUrls(value)).toThrow();
  });

  it("uses one stable, tenant-scoped idempotency key", () => {
    const restaurantId = "11111111-0000-4000-8000-000000000001";
    expect(stripeCustomerIdempotencyKey(restaurantId)).toBe(
      "restamenu:billing-customer:11111111-0000-4000-8000-000000000001",
    );
    expect(() => stripeCustomerIdempotencyKey("not-a-uuid")).toThrow();
  });

  it("accepts the canonical Postgres UUIDs used by the migrated demo tenants", () => {
    const migratedRestaurantId = "11111111-0000-0000-0000-000000000001";
    expect(stripeCustomerIdempotencyKey(migratedRestaurantId)).toBe(
      `restamenu:billing-customer:${migratedRestaurantId}`,
    );
  });
});
