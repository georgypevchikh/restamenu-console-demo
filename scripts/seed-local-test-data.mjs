import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// supabase-js instantiates a Realtime client that resolves a WebSocket
// implementation eagerly. Node 20 has no global WebSocket (native only from
// Node 21+), so on the CI runtime that resolution throws before any seeding
// runs. This script never uses Realtime, but the client still needs a WS
// constructor present — provide one. Harmless where a native global exists.
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocket;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testDemoPassword = process.env.TEST_DEMO_PASSWORD;

if (!url || !serviceRoleKey || !testDemoPassword) {
  throw new Error(
    "seed-local-test-data requires NEXT_PUBLIC_SUPABASE_URL, " +
      "SUPABASE_SERVICE_ROLE_KEY, and TEST_DEMO_PASSWORD",
  );
}

const admin = createClient(url, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const RESTAURANTS = {
  bella: "11111111-0000-0000-0000-000000000001",
  sakura: "22222222-0000-0000-0000-000000000002",
};
const CATEGORIES = {
  bellaProduce: "11111111-1000-4000-8000-000000000001",
  bellaDairy: "11111111-1000-4000-8000-000000000002",
  sakuraProduce: "22222222-1000-4000-8000-000000000001",
};
const PRODUCTS = {
  bellaTomato: "11111111-2000-4000-8000-000000000001",
  bellaMilk: "11111111-2000-4000-8000-000000000002",
  sakuraRice: "22222222-2000-4000-8000-000000000001",
};

const USERS = [
  {
    key: "bellaManager",
    email: "manager@bella-italia.demo",
    name: "Bella Manager",
  },
  { key: "bellaStaff", email: "staff@bella-italia.demo", name: "Bella Team" },
  {
    key: "sakuraManager",
    email: "manager@sakura-house.demo",
    name: "Sakura Manager",
  },
  { key: "sakuraStaff", email: "staff@sakura-house.demo", name: "Sakura Team" },
];

function ensure(result, operation) {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message}`);
  }
  return result.data;
}

async function ensureUsers() {
  const listed = ensure(
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    "list local auth users",
  );
  const byEmail = new Map(listed.users.map((user) => [user.email, user]));
  const ids = {};

  for (const account of USERS) {
    let user = byEmail.get(account.email);
    if (!user) {
      const created = ensure(
        await admin.auth.admin.createUser({
          email: account.email,
          password: testDemoPassword,
          email_confirm: true,
          user_metadata: { full_name: account.name },
        }),
        `create ${account.email}`,
      );
      user = created.user;
    }
    if (!user)
      throw new Error(`Auth API returned no user for ${account.email}`);
    ids[account.key] = user.id;
  }

  ensure(
    await admin.from("profiles").upsert(
      USERS.map((account) => ({
        id: ids[account.key],
        email: account.email,
        full_name: account.name,
      })),
    ),
    "upsert local profiles",
  );

  return ids;
}

const users = await ensureUsers();

ensure(
  await admin.from("restaurants").upsert([
    {
      id: RESTAURANTS.bella,
      name: "Bella Italia",
      region: "EU",
      created_by: users.bellaManager,
    },
    {
      id: RESTAURANTS.sakura,
      name: "Sakura House",
      region: "EU",
      created_by: users.sakuraManager,
    },
  ]),
  "upsert local restaurants",
);

ensure(
  await admin.from("restaurant_members").upsert(
    [
      {
        restaurant_id: RESTAURANTS.bella,
        user_id: users.bellaManager,
        role: "manager",
      },
      {
        restaurant_id: RESTAURANTS.bella,
        user_id: users.bellaStaff,
        role: "team",
      },
      {
        restaurant_id: RESTAURANTS.sakura,
        user_id: users.sakuraManager,
        role: "manager",
      },
      {
        restaurant_id: RESTAURANTS.sakura,
        user_id: users.sakuraStaff,
        role: "team",
      },
    ],
    { onConflict: "restaurant_id,user_id" },
  ),
  "upsert local memberships",
);

ensure(
  await admin.from("categories").upsert([
    {
      id: CATEGORIES.bellaProduce,
      restaurant_id: RESTAURANTS.bella,
      name: "Produce",
      icon: "🥬",
    },
    {
      id: CATEGORIES.bellaDairy,
      restaurant_id: RESTAURANTS.bella,
      name: "Dairy",
      icon: "🥛",
    },
    {
      id: CATEGORIES.sakuraProduce,
      restaurant_id: RESTAURANTS.sakura,
      name: "Produce",
      icon: "🍚",
    },
  ]),
  "upsert local categories",
);

ensure(
  await admin.from("products").upsert([
    {
      id: PRODUCTS.bellaTomato,
      restaurant_id: RESTAURANTS.bella,
      category_id: CATEGORIES.bellaProduce,
      name: "Tomatoes",
      unit: "kg",
      min_quantity: 5,
      current_stock: 2,
    },
    {
      id: PRODUCTS.bellaMilk,
      restaurant_id: RESTAURANTS.bella,
      category_id: CATEGORIES.bellaDairy,
      name: "Milk",
      unit: "l",
      min_quantity: 8,
      current_stock: 3,
    },
    {
      id: PRODUCTS.sakuraRice,
      restaurant_id: RESTAURANTS.sakura,
      category_id: CATEGORIES.sakuraProduce,
      name: "Rice",
      unit: "kg",
      min_quantity: 10,
      current_stock: 4,
    },
  ]),
  "upsert local products",
);

ensure(
  await admin.from("suppliers").upsert([
    {
      id: "11111111-3000-4000-8000-000000000001",
      product_id: PRODUCTS.bellaTomato,
      name: "Local Produce Ltd",
      price: 2.5,
      is_primary: true,
    },
  ]),
  "upsert local suppliers",
);

ensure(
  await admin.from("purchase_requests").upsert([
    {
      id: "11111111-4000-4000-8000-000000000001",
      restaurant_id: RESTAURANTS.bella,
      product_id: PRODUCTS.bellaTomato,
      created_by: users.bellaStaff,
      quantity: 3,
      priority: "normal",
      status: "pending",
    },
    {
      // Manager-authored request so the full Bella queue (manager view) is
      // strictly larger than a team member's own-rows-only view.
      id: "11111111-4000-4000-8000-000000000002",
      restaurant_id: RESTAURANTS.bella,
      product_id: PRODUCTS.bellaMilk,
      created_by: users.bellaManager,
      quantity: 2,
      priority: "normal",
      status: "pending",
    },
    {
      id: "22222222-4000-4000-8000-000000000001",
      restaurant_id: RESTAURANTS.sakura,
      product_id: PRODUCTS.sakuraRice,
      created_by: users.sakuraManager,
      quantity: 5,
      priority: "normal",
      status: "pending",
    },
  ]),
  "upsert local purchase requests",
);

const taxRules = (standardRateBps) => [
  {
    kind: "vat",
    name: "Standard VAT",
    rate_bps: standardRateBps,
    applies_to: "default",
  },
  {
    kind: "vat",
    name: "Reduced VAT",
    rate_bps: 900,
    applies_to: "categories",
    categories: ["Produce", "Dairy"],
  },
  {
    kind: "withholding",
    name: "Vendor withholding",
    rate_bps: 200,
    threshold_minor: 100000,
  },
];

const ruleRows = [];
for (const [index, restaurantId] of Object.values(RESTAURANTS).entries()) {
  const prefix = index === 0 ? "11111111" : "22222222";
  ruleRows.push(
    {
      id: `${prefix}-5000-0000-0000-000000000001`,
      restaurant_id: restaurantId,
      version: 1,
      name: "EU VAT 2026 H1",
      effective_from: "2026-01-01",
      effective_to: "2026-06-30",
      rounding_mode: "half_up",
      rules: taxRules(2100),
    },
    {
      id: `${prefix}-5000-0000-0000-000000000002`,
      restaurant_id: restaurantId,
      version: 2,
      name: "EU VAT 2026 H2",
      effective_from: "2026-07-01",
      effective_to: null,
      rounding_mode: "half_up",
      rules: taxRules(2200),
    },
  );
}

ensure(
  await admin
    .from("tax_rule_sets")
    .upsert(ruleRows, { onConflict: "restaurant_id,version" }),
  "upsert local tax rule sets",
);

ensure(
  await admin.from("subscriptions").upsert(
    {
      restaurant_id: RESTAURANTS.bella,
      stripe_subscription_id: "sub_demo_seed_bella",
      status: "active",
      price_id: "price_demo_seed",
      current_period_end: "2026-12-31T23:59:59Z",
      last_event_created: 0,
    },
    { onConflict: "stripe_subscription_id" },
  ),
  "upsert local Bella subscription",
);

console.log("Local Supabase test fixture is ready.");
