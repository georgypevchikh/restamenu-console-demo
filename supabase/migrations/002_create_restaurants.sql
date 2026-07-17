create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  region      text not null check (region in ('EU', 'US')),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);
