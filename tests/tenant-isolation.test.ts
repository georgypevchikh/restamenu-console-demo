/**
 * Tenant isolation test — proves that RLS policies in Postgres
 * prevent cross-restaurant data leakage at the database level.
 *
 * Each test signs in as a different user and asserts that only
 * their own restaurant's rows are visible.
 */

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, it, expect } from "vitest";
import * as dotenv from "dotenv";
import * as path from "path";
import WebSocket from "ws";

// Node 20 has no native WebSocket — provide the ws package so Supabase Realtime works
if (!globalThis.WebSocket) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = WebSocket;
}

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const TEST_DEMO_PASSWORD = process.env.TEST_DEMO_PASSWORD ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_DEMO_PASSWORD) {
  throw new Error(
    "Live isolation tests require NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY, and TEST_DEMO_PASSWORD",
  );
}

const BELLA = {
  email: "manager@bella-italia.demo",
  password: TEST_DEMO_PASSWORD,
  restaurantId: "11111111-0000-0000-0000-000000000001",
  name: "Bella Italia",
};

const SAKURA = {
  email: "manager@sakura-house.demo",
  password: TEST_DEMO_PASSWORD,
  restaurantId: "22222222-0000-0000-0000-000000000002",
  name: "Sakura House",
};

async function signedInClient(email: string, password: string) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`);
  return client;
}

type SignedInClient = Awaited<ReturnType<typeof signedInClient>>;
let bellaClient: SignedInClient;
let sakuraClient: SignedInClient;
let bellaUserId: string;

describe("Tenant isolation — RLS", () => {
  beforeAll(async () => {
    [bellaClient, sakuraClient] = await Promise.all([
      signedInClient(BELLA.email, BELLA.password),
      signedInClient(SAKURA.email, SAKURA.password),
    ]);
    const { data: { session } } = await bellaClient.auth.getSession();
    if (!session) throw new Error("Bella session missing after sign-in");
    bellaUserId = session.user.id;
  });

  it("Bella Italia manager sees only their own products", async () => {
    const { data, error } = await bellaClient.from("products").select("restaurant_id, name");
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // Every row must belong to Bella Italia
    const alien = data!.filter((r) => r.restaurant_id !== BELLA.restaurantId);
    expect(alien).toHaveLength(0);
  });

  it("Sakura House manager sees only their own products", async () => {
    const { data, error } = await sakuraClient.from("products").select("restaurant_id, name");
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // Every row must belong to Sakura House
    const alien = data!.filter((r) => r.restaurant_id !== SAKURA.restaurantId);
    expect(alien).toHaveLength(0);
  });

  it("Bella Italia manager cannot see Sakura House products", async () => {
    const { data, error } = await bellaClient
      .from("products")
      .select("restaurant_id")
      .eq("restaurant_id", SAKURA.restaurantId);
    expect(error).toBeNull();
    // RLS must return empty set — not an error, just zero rows
    expect(data).toHaveLength(0);
  });

  it("Sakura House manager cannot see Bella Italia purchase requests", async () => {
    const { data, error } = await sakuraClient
      .from("purchase_requests")
      .select("restaurant_id")
      .eq("restaurant_id", BELLA.restaurantId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("Bella Italia manager cannot write a request into Sakura House", async () => {
    // Reading is only half of isolation: a tenant must not be able to plant
    // rows in another tenant's account either. The app never builds such a
    // request, so this asserts the database refuses it on its own.
    const { data: ownProduct } = await bellaClient
      .from("products")
      .select("id")
      .limit(1)
      .single();

    const { data, error } = await bellaClient
      .from("purchase_requests")
      .insert({
        restaurant_id: SAKURA.restaurantId,
        product_id: ownProduct!.id,
        created_by: bellaUserId,
        quantity: 99,
        priority: "urgent",
        status: "pending",
      })
      .select();

    // Postgres rejects the write via the INSERT policy's WITH CHECK clause
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(data).toBeNull();

  });

  it("cannot attach a Sakura product to a Bella request", async () => {
    // The restaurant itself is Bella (so the RLS tenant check passes). The
    // composite product_id + restaurant_id foreign key must reject the source
    // row instead of allowing a cross-tenant product to poison later joins.
    const { data: foreignProduct, error: productError } = await sakuraClient
      .from("products")
      .select("id")
      .limit(1)
      .single();
    expect(productError).toBeNull();

    const { data, error } = await bellaClient
      .from("purchase_requests")
      .insert({
        restaurant_id: BELLA.restaurantId,
        product_id: foreignProduct!.id,
        created_by: bellaUserId,
        quantity: 1,
        priority: "normal",
        status: "pending",
      })
      .select();

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
    expect(data).toBeNull();
  });

  it("cannot spoof a teammate as the request creator", async () => {
    const [{ data: ownProduct }, { data: teammate }] = await Promise.all([
      bellaClient.from("products").select("id").limit(1).single(),
      bellaClient
        .from("profiles")
        .select("id")
        .eq("email", "staff@bella-italia.demo")
        .single(),
    ]);

    const { data, error } = await bellaClient
      .from("purchase_requests")
      .insert({
        restaurant_id: BELLA.restaurantId,
        product_id: ownProduct!.id,
        created_by: teammate!.id,
        quantity: 1,
        priority: "normal",
        status: "pending",
      })
      .select();

    expect(error).not.toBeNull();
    expect(error!.code).toBe("P0001");
    expect(error!.message).toContain(
      "request_creator_must_match_authenticated_user",
    );
    expect(data).toBeNull();
  });

  it("rejects non-positive request quantities", async () => {
    const { data: ownProduct } = await bellaClient
      .from("products")
      .select("id")
      .limit(1)
      .single();

    for (const quantity of [0, -1]) {
      const { data, error } = await bellaClient
        .from("purchase_requests")
        .insert({
          restaurant_id: BELLA.restaurantId,
          product_id: ownProduct!.id,
          created_by: bellaUserId,
          quantity,
          priority: "normal",
          status: "pending",
        })
        .select();

      expect(error).not.toBeNull();
      expect(error!.code).toBe("P0001");
      expect(error!.message).toContain("request_quantity_must_be_positive");
      expect(data).toBeNull();
    }
  });

  it("rejects request quantities outside the tax engine's exact range", async () => {
    const { data: ownProduct } = await bellaClient
      .from("products")
      .select("id")
      .limit(1)
      .single();

    for (const [quantity, message] of [
      [1.2345, "request_quantity_must_have_at_most_three_decimals"],
      [9_007_199_254_741, "request_quantity_too_large"],
    ] as const) {
      const { data, error } = await bellaClient
        .from("purchase_requests")
        .insert({
          restaurant_id: BELLA.restaurantId,
          product_id: ownProduct!.id,
          created_by: bellaUserId,
          quantity,
          priority: "normal",
          status: "pending",
        })
        .select();

      expect(error).not.toBeNull();
      expect(error!.code).toBe("P0001");
      expect(error!.message).toContain(message);
      expect(data).toBeNull();
    }
  });

  it("rejects an authenticated request inserted directly into a terminal state", async () => {
    const { data: ownProduct } = await bellaClient
      .from("products")
      .select("id")
      .limit(1)
      .single();

    const { data, error } = await bellaClient
      .from("purchase_requests")
      .insert({
        restaurant_id: BELLA.restaurantId,
        product_id: ownProduct!.id,
        created_by: bellaUserId,
        quantity: 1,
        priority: "normal",
        status: "bought",
      })
      .select();

    expect(error).not.toBeNull();
    expect(error!.code).toBe("P0001");
    expect(error!.message).toContain("new_request_must_be_pending");
    expect(data).toBeNull();
  });

  it("Profiles are visible to teammates but not across tenants", async () => {
    // profiles: teammate read (migration 013) widened profile visibility so the
    // "Requested by" column can resolve names. It must not leak past the tenant.
    const { data, error } = await bellaClient.from("profiles").select("full_name, email");
    expect(error).toBeNull();

    const emails = (data ?? []).map((p) => p.email);
    expect(emails).toContain("manager@bella-italia.demo"); // self
    expect(emails).toContain("staff@bella-italia.demo"); // teammate
    expect(emails.some((e) => e?.includes("sakura-house"))).toBe(false);

  });

  it("Products counts differ between tenants (data is not shared)", async () => {
    const [bellaResult, sakuraResult] = await Promise.all([
      bellaClient.from("products").select("id"),
      sakuraClient.from("products").select("id"),
    ]);

    // Both should have data
    expect(bellaResult.data!.length).toBeGreaterThan(0);
    expect(sakuraResult.data!.length).toBeGreaterThan(0);

    // No ID overlap — proving complete row-level isolation
    const bellaIds = new Set(bellaResult.data!.map((r) => r.id));
    const sakuraIds = sakuraResult.data!.map((r) => r.id);
    const overlap = sakuraIds.filter((id) => bellaIds.has(id));
    expect(overlap).toHaveLength(0);
  });
});
