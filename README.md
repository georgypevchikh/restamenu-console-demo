# Restamenu Console — Public Demo

> Multi-tenant restaurant management console. Built to demonstrate **Supabase Row Level Security** enforcing tenant isolation at the database layer — not the application layer.

**Live demo:** [restamenu-console-demo.vercel.app](https://restamenu-console-demo.vercel.app) *(link after deploy)*

**Tech stack:** Next.js 15 · TypeScript · Supabase (Auth + Postgres + RLS) · Vercel · GitHub Actions

---

## What this demonstrates

| Claim | Proof |
|---|---|
| Multi-tenant architecture with row-level isolation | Log in as Bella Italia → see only Bella Italia products. Log in as Sakura House → see only Sakura House. RLS rejects cross-tenant queries at Postgres level. |
| RLS policies on 10 tables | `supabase/migrations/009_enable_rls.sql` — policies on every table using `is_member()` / `is_manager()` helpers |
| CI proving isolation doesn't regress | `tests/tenant-isolation.test.ts` — 5 vitest tests run on every push via GitHub Actions |
| Server-side data fetching | Dashboard pages are Next.js Server Components — no client-side data leakage |
| Role-based access (manager vs staff) | Manager badge in nav; manager-only insert/update policies in Postgres |

---

## Demo accounts

| Account | Email | Role |
|---|---|---|
| 🍕 Bella Italia — Manager | manager@bella-italia.demo | manager |
| 🍕 Bella Italia — Staff | staff@bella-italia.demo | staff |
| 🍣 Sakura House — Manager | manager@sakura-house.demo | manager |
| 🍣 Sakura House — Staff | staff@sakura-house.demo | staff |

Password: `demo1234`

---

## Setup (your own Supabase project)

### 1. Create a Supabase project

Create a **new** project at [supabase.com](https://supabase.com) — don't reuse production data.

### 2. Run migrations

In Supabase SQL Editor, run each file in order:

```
supabase/migrations/001_create_profiles.sql
supabase/migrations/002_create_restaurants.sql
...
supabase/migrations/009_enable_rls.sql
supabase/migrations/010_seed_default_categories.sql
```

### 3. Run seed

```sql
-- supabase/seed.sql
-- Creates 2 restaurants with product sets
```

### 4. Create demo auth users

In Supabase Dashboard → Authentication → Users, create 4 users:

| Email | Password |
|---|---|
| manager@bella-italia.demo | demo1234 |
| staff@bella-italia.demo | demo1234 |
| manager@sakura-house.demo | demo1234 |
| staff@sakura-house.demo | demo1234 |

After creation, copy their UUIDs and run:

```sql
-- Replace <UUID_*> with actual auth.users IDs
insert into public.restaurant_members (user_id, restaurant_id, role) values
  ('<UUID_BELLA_MANAGER>', '11111111-0000-0000-0000-000000000001', 'manager'),
  ('<UUID_BELLA_STAFF>',   '11111111-0000-0000-0000-000000000001', 'staff'),
  ('<UUID_SAKURA_MANAGER>','22222222-0000-0000-0000-000000000002', 'manager'),
  ('<UUID_SAKURA_STAFF>',  '22222222-0000-0000-0000-000000000002', 'staff');

-- Also update profiles (created automatically by trigger)
update public.profiles set full_name = 'Marco (Manager)' where id = '<UUID_BELLA_MANAGER>';
update public.profiles set full_name = 'Giulia (Staff)'  where id = '<UUID_BELLA_STAFF>';
update public.profiles set full_name = 'Yuki (Manager)'  where id = '<UUID_SAKURA_MANAGER>';
update public.profiles set full_name = 'Hana (Staff)'    where id = '<UUID_SAKURA_STAFF>';
```

### 5. Local env

```bash
cp .env.example .env.local
# Fill NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from project settings
# Fill SUPABASE_SERVICE_ROLE_KEY for tests (never exposed to browser)
```

### 6. Run locally

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # tenant isolation tests
npm run typecheck  # TypeScript strict check
```

### 7. Deploy to Vercel

```bash
# One-time
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY

# Deploy
vercel --prod
```

Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to GitHub repo secrets for CI.

---

## Architecture

```
Browser → Next.js (Vercel)
            ├── Server Components (data fetch with user session cookie)
            ├── Middleware (auth guard — redirect unauthenticated to /login)
            └── Supabase SSR client
                    └── Postgres (RLS policies on 10 tables)
                            ├── is_member(restaurant_id) — row visibility gate
                            └── is_manager(restaurant_id) — write gate
```

RLS means even if the application had a bug and passed the wrong `restaurant_id`, Postgres would return zero rows. **The isolation is enforced by the database, not by the application.**

---

## Related

- Full mobile app (private): `github.com/georgypevchikh/restamenu` — Expo Router, same Supabase backend
- Portfolio: [upwork.com/freelancers/~01c6b4199075060eea](https://www.upwork.com/freelancers/~01c6b4199075060eea)
- GitHub: [github.com/georgypevchikh](https://github.com/georgypevchikh)
