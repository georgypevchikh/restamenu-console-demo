create table public.notifications (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  recipient_id   uuid not null references public.profiles (id) on delete cascade,
  type           text not null,
  reference_id   uuid,
  is_read        boolean not null default false,
  created_at     timestamptz not null default now()
);
