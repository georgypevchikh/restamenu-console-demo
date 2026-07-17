-- Enable RLS on all tables
alter table public.profiles           enable row level security;
alter table public.restaurants        enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.invites            enable row level security;
alter table public.categories         enable row level security;
alter table public.products           enable row level security;
alter table public.suppliers          enable row level security;
alter table public.purchase_requests  enable row level security;
alter table public.purchases          enable row level security;
alter table public.notifications      enable row level security;

-- Helper: is the current user a member of a given restaurant?
create or replace function public.is_member(restaurant_id uuid)
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.restaurant_members
    where restaurant_members.restaurant_id = $1
      and user_id = auth.uid()
  );
$$;

-- Helper: is the current user a manager of a given restaurant?
create or replace function public.is_manager(restaurant_id uuid)
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.restaurant_members
    where restaurant_members.restaurant_id = $1
      and user_id = auth.uid()
      and role = 'manager'
  );
$$;

-- profiles: users can read/update their own row
create policy "profiles: own read"   on public.profiles for select using (id = auth.uid());
create policy "profiles: own update" on public.profiles for update using (id = auth.uid());

-- restaurants: members can read, managers can update
create policy "restaurants: member read"    on public.restaurants for select using (public.is_member(id));
create policy "restaurants: manager update" on public.restaurants for update using (public.is_manager(id));

-- restaurant_members: members can read their restaurant's roster
create policy "members: member read" on public.restaurant_members for select using (public.is_member(restaurant_id));

-- invites: managers can insert/read; anyone can read by token (for accepting)
create policy "invites: manager insert" on public.invites for insert with check (public.is_manager(restaurant_id));
create policy "invites: member read"    on public.invites for select using (public.is_member(restaurant_id));

-- categories: members read, managers write
create policy "categories: member read"    on public.categories for select using (public.is_member(restaurant_id));
create policy "categories: manager insert" on public.categories for insert with check (public.is_manager(restaurant_id));
create policy "categories: manager update" on public.categories for update using (public.is_manager(restaurant_id));
create policy "categories: manager delete" on public.categories for delete using (public.is_manager(restaurant_id));

-- products: members read, managers write
create policy "products: member read"    on public.products for select using (public.is_member(restaurant_id));
create policy "products: manager insert" on public.products for insert with check (public.is_manager(restaurant_id));
create policy "products: manager update" on public.products for update using (public.is_manager(restaurant_id));
create policy "products: manager delete" on public.products for delete using (public.is_manager(restaurant_id));

-- suppliers: inherit product's restaurant via join
create policy "suppliers: member read" on public.suppliers for select
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_member(p.restaurant_id)
  ));
create policy "suppliers: manager write" on public.suppliers for all
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_manager(p.restaurant_id)
  ));

-- purchase_requests: members read, all members can insert, managers can update/delete
create policy "requests: member read"    on public.purchase_requests for select using (public.is_member(restaurant_id));
create policy "requests: member insert"  on public.purchase_requests for insert with check (public.is_member(restaurant_id));
create policy "requests: manager update" on public.purchase_requests for update using (public.is_manager(restaurant_id));
create policy "requests: manager delete" on public.purchase_requests for delete using (public.is_manager(restaurant_id));

-- purchases: members read, managers write
create policy "purchases: member read"    on public.purchases for select using (public.is_member(restaurant_id));
create policy "purchases: manager insert" on public.purchases for insert with check (public.is_manager(restaurant_id));

-- notifications: recipient reads their own
create policy "notifications: own read"   on public.notifications for select using (recipient_id = auth.uid());
create policy "notifications: own update" on public.notifications for update using (recipient_id = auth.uid());
