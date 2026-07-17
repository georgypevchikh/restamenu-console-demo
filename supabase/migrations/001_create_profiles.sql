create table public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);
