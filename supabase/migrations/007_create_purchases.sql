create table public.purchases (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid references public.purchase_requests (id) on delete set null,
  restaurant_id    uuid not null references public.restaurants (id) on delete cascade,
  bought_quantity  decimal not null,
  supplier_name    text,
  price_paid       decimal,
  bought_by        uuid references public.profiles (id) on delete set null,
  bought_at        timestamptz not null default now()
);
