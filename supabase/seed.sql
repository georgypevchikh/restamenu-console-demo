-- ============================================================
-- Demo seed — 2 restaurants, 4 users, isolated product sets
-- Run AFTER migrations 001–010 are applied
-- Users are created via Supabase Auth (see README)
-- ============================================================

-- Insert demo restaurant rows (UUIDs are stable for tests)
insert into public.restaurants (id, name, region) values
  ('11111111-0000-0000-0000-000000000001', 'Bella Italia', 'EU'),
  ('22222222-0000-0000-0000-000000000002', 'Sakura House', 'EU')
on conflict (id) do nothing;

-- NOTE: profiles are auto-inserted by trigger on auth.users sign-up.
-- Run this seed AFTER creating auth users in Supabase dashboard or via script.
-- Replace UUIDs below with the real auth.users UUIDs after user creation.

-- restaurant_members (filled by setup script after user creation)
-- See README: "Seeding demo users"

-- Products for Bella Italia
insert into public.products (restaurant_id, name, unit, min_quantity, current_stock) values
  ('11111111-0000-0000-0000-000000000001', 'Flour 00', 'kg',  10,  8),
  ('11111111-0000-0000-0000-000000000001', 'Tomatoes', 'kg',  5,   12),
  ('11111111-0000-0000-0000-000000000001', 'Mozzarella', 'kg', 3,  1),
  ('11111111-0000-0000-0000-000000000001', 'Olive oil', 'L',  4,   6),
  ('11111111-0000-0000-0000-000000000001', 'Basil', 'bunch', 3,   2)
on conflict do nothing;

-- Products for Sakura House
insert into public.products (restaurant_id, name, unit, min_quantity, current_stock) values
  ('22222222-0000-0000-0000-000000000002', 'Sushi rice', 'kg', 10, 15),
  ('22222222-0000-0000-0000-000000000002', 'Nori sheets', 'pack', 5, 3),
  ('22222222-0000-0000-0000-000000000002', 'Salmon', 'kg', 4,  7),
  ('22222222-0000-0000-0000-000000000002', 'Soy sauce', 'L', 3,  2),
  ('22222222-0000-0000-0000-000000000002', 'Wasabi', 'tube', 5, 1)
on conflict do nothing;
