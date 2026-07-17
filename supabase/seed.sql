-- ============================================================
-- Demo seed — 2 restaurants, 4 users, isolated product sets
-- Run AFTER migrations 001–012 are applied
-- Users are created via Supabase Auth (see README)
-- ============================================================

-- Insert demo restaurant rows (UUIDs are stable for tests)
insert into public.restaurants (id, name, region) values
  ('11111111-0000-0000-0000-000000000001', 'Bella Italia', 'EU'),
  ('22222222-0000-0000-0000-000000000002', 'Sakura House', 'EU')
on conflict (id) do nothing;

-- NOTE: profiles are auto-inserted by trigger on auth.users sign-up.
-- Run this seed AFTER creating auth users in Supabase dashboard or via script.

-- Default categories per restaurant (migration 012)
select public.seed_default_categories(id) from public.restaurants;

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

-- Assign each product to a category
update public.products p set category_id = c.id
from public.categories c
where c.restaurant_id = p.restaurant_id
  and c.name = case p.name
    when 'Basil'       then 'Produce'
    when 'Tomatoes'    then 'Produce'
    when 'Mozzarella'  then 'Dairy'
    when 'Flour 00'    then 'Dry goods'
    when 'Olive oil'   then 'Oils'
    when 'Salmon'      then 'Seafood'
    when 'Sushi rice'  then 'Dry goods'
    when 'Nori sheets' then 'Dry goods'
    when 'Soy sauce'   then 'Condiments'
    when 'Wasabi'      then 'Condiments'
  end
  and p.category_id is null;

-- Purchase requests: both tenants active, mixed priorities and statuses.
-- Urgent rows sit on products that are actually below min_quantity, so the
-- dashboard counters tell a coherent story.
--
-- The alert trigger is suspended here: seeding is not a real urgent request and
-- should not page anyone.
alter table public.purchase_requests disable trigger urgent_request_alert;

insert into public.purchase_requests
  (restaurant_id, product_id, created_by, quantity, priority, status, stock_at_request, created_at)
select p.restaurant_id, p.id, prof.id, v.qty, v.prio, v.st, p.current_stock, now() - v.ago
from (values
  ('Bella Italia', 'Mozzarella',  5,  'urgent',    'pending',   'staff@bella-italia.demo',   interval '2 hours'),
  ('Bella Italia', 'Basil',       4,  'by_lunch',  'pending',   'staff@bella-italia.demo',   interval '5 hours'),
  ('Bella Italia', 'Flour 00',    20, 'normal',    'bought',    'manager@bella-italia.demo', interval '2 days'),
  ('Bella Italia', 'Tomatoes',    10, 'whenever',  'cancelled', 'manager@bella-italia.demo', interval '4 days'),
  ('Sakura House', 'Wasabi',      6,  'urgent',    'pending',   'staff@sakura-house.demo',   interval '1 hour'),
  ('Sakura House', 'Nori sheets', 10, 'by_dinner', 'pending',   'staff@sakura-house.demo',   interval '8 hours'),
  ('Sakura House', 'Salmon',      5,  'normal',    'bought',    'manager@sakura-house.demo', interval '3 days')
) as v(rest, prod, qty, prio, st, email, ago)
join public.restaurants r on r.name = v.rest
join public.products p on p.restaurant_id = r.id and p.name = v.prod
join public.profiles prof on prof.email = v.email;

alter table public.purchase_requests enable trigger urgent_request_alert;
