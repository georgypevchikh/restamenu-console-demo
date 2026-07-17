-- Migration 010 left seed_default_categories() as an empty stub ("populated in
-- a later migration"), so every restaurant was created with no categories and
-- the Category column rendered as a dash for every product. This is that
-- migration.
--
-- Categories are per-restaurant rather than global: two tenants may organise
-- the same ingredient differently, and the table is already scoped by
-- restaurant_id under RLS.

create or replace function public.seed_default_categories(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.categories (restaurant_id, name, icon)
  values
    (p_restaurant_id, 'Produce',    '🥬'),
    (p_restaurant_id, 'Dairy',      '🧀'),
    (p_restaurant_id, 'Dry goods',  '🌾'),
    (p_restaurant_id, 'Oils',       '🫒'),
    (p_restaurant_id, 'Seafood',    '🐟'),
    (p_restaurant_id, 'Condiments', '🍶')
  on conflict do nothing;
end;
$$;

comment on function public.seed_default_categories(uuid) is
  'Creates the default category set for a newly created restaurant.';

-- Backfill the two demo restaurants, which were created before this existed.
select public.seed_default_categories(id) from public.restaurants;
