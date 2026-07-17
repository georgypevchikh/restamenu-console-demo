create table public.purchase_requests (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants (id) on delete cascade,
  product_id        uuid not null references public.products (id) on delete cascade,
  created_by        uuid references public.profiles (id) on delete set null,
  quantity          decimal not null,
  priority          text not null default 'normal'
                      check (priority in ('urgent', 'normal', 'whenever', 'by_breakfast', 'by_lunch', 'by_dinner')),
  status            text not null default 'pending'
                      check (status in ('pending', 'bought', 'not_found', 'partial', 'cancelled')),
  stock_at_request  decimal,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
