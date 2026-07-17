create table public.categories (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  name           text not null,
  icon           text,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now()
);
