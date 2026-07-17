-- profiles could only ever be read by their owner (id = auth.uid()), so the
-- "Requested by" column rendered a dash for every request except your own:
-- the join to profiles returned nothing for teammates. A manager could not see
-- who raised an urgent request, which is the point of the column.
--
-- Teammates — and only teammates — may now read each other's profile. Members
-- of another restaurant stay invisible, so tenant isolation is unchanged.

-- SECURITY DEFINER for the same reason as is_member/is_manager: a policy on
-- profiles that queried restaurant_members directly would re-enter RLS.
create or replace function public.shares_restaurant_with(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_members me
    join public.restaurant_members them on them.restaurant_id = me.restaurant_id
    where me.user_id = auth.uid()
      and them.user_id = p_user_id
  );
$$;

comment on function public.shares_restaurant_with(uuid) is
  'True when the current user and p_user_id belong to at least one restaurant in common.';

create policy "profiles: teammate read"
  on public.profiles
  for select
  using (public.shares_restaurant_with(id));
