create table public.products (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete cascade,
  category_id     uuid references public.categories (id) on delete set null,
  name            text not null,
  unit            text not null,
  volume          decimal,
  volume_unit     text,
  min_quantity    decimal not null default 0,
  current_stock   decimal,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products (id) on delete cascade,
  name        text not null,
  price       decimal,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);
