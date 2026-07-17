/**
 * Tenant isolation test — proves that RLS policies in Postgres
 * prevent cross-restaurant data leakage at the database level.
 *
 * Each test signs in as a different user and asserts that only
 * their own restaurant's rows are visible.
 */

import { createClient } from "@supabase/supabase-js";
import { describe, it, expect } from "vitest";
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

const BELLA = {
  email: "manager@bella-italia.demo",
  password: "demo1234",
  restaurantId: "11111111-0000-0000-0000-000000000001",
  name: "Bella Italia",
};

const SAKURA = {
  email: "manager@sakura-house.demo",
  password: "demo1234",
  restaurantId: "22222222-0000-0000-0000-000000000002",
  name: "Sakura House",
};

async function signedInClient(email: string, password: string) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`);
  return client;
}

describe("Tenant isolation — RLS", () => {
  it("Bella Italia manager sees only their own products", async () => {
    const client = await signedInClient(BELLA.email, BELLA.password);
    const { data, error } = await client.from("products").select("restaurant_id, name");
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // Every row must belong to Bella Italia
    const alien = data!.filter((r) => r.restaurant_id !== BELLA.restaurantId);
    expect(alien).toHaveLength(0);
    await client.auth.signOut();
  });

  it("Sakura House manager sees only their own products", async () => {
    const client = await signedInClient(SAKURA.email, SAKURA.password);
    const { data, error } = await client.from("products").select("restaurant_id, name");
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // Every row must belong to Sakura House
    const alien = data!.filter((r) => r.restaurant_id !== SAKURA.restaurantId);
    expect(alien).toHaveLength(0);
    await client.auth.signOut();
  });

  it("Bella Italia manager cannot see Sakura House products", async () => {
    const client = await signedInClient(BELLA.email, BELLA.password);
    const { data, error } = await client
      .from("products")
      .select("restaurant_id")
      .eq("restaurant_id", SAKURA.restaurantId);
    expect(error).toBeNull();
    // RLS must return empty set — not an error, just zero rows
    expect(data).toHaveLength(0);
    await client.auth.signOut();
  });

  it("Sakura House manager cannot see Bella Italia purchase requests", async () => {
    const client = await signedInClient(SAKURA.email, SAKURA.password);
    const { data, error } = await client
      .from("purchase_requests")
      .select("restaurant_id")
      .eq("restaurant_id", BELLA.restaurantId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    await client.auth.signOut();
  });

  it("Bella Italia manager cannot write a request into Sakura House", async () => {
    // Reading is only half of isolation: a tenant must not be able to plant
    // rows in another tenant's account either. The app never builds such a
    // request, so this asserts the database refuses it on its own.
    const client = await signedInClient(BELLA.email, BELLA.password);

    const { data: ownProduct } = await client
      .from("products")
      .select("id")
      .limit(1)
      .single();

    const { data, error } = await client
      .from("purchase_requests")
      .insert({
        restaurant_id: SAKURA.restaurantId,
        product_id: ownProduct!.id,
        quantity: 99,
        priority: "urgent",
      })
      .select();

    // Postgres rejects the write via the INSERT policy's WITH CHECK clause
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(data).toBeNull();

    await client.auth.signOut();
  });

  it("Products counts differ between tenants (data is not shared)", async () => {
    const bellaClient = await signedInClient(BELLA.email, BELLA.password);
    const sakuraClient = await signedInClient(SAKURA.email, SAKURA.password);

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

    await Promise.all([bellaClient.auth.signOut(), sakuraClient.auth.signOut()]);
  });
});
