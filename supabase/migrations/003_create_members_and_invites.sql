create table public.restaurant_members (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  role           text not null check (role in ('manager', 'team')),
  joined_at      timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create table public.invites (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  created_by     uuid references public.profiles (id) on delete set null,
  role           text not null default 'team',
  token          text not null unique,
  expires_at     timestamptz,
  used_at        timestamptz,
  used_by        uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
