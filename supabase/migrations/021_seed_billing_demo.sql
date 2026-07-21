-- Demo billing state: Bella Italia arrives already subscribed (seeded
-- subscription → the trigger grants the entitlement), Sakura House stays on
-- the free tier. A reviewer signing in as Sakura sees the locked state and
-- can exercise the real Stripe test-mode checkout; Bella shows the unlocked
-- feature set immediately.
--
-- The subscription id is transparently fake ('sub_demo_seed_...') — this row
-- documents itself as seeded demo state, not Stripe history.

insert into public.subscriptions
  (restaurant_id, stripe_subscription_id, status, price_id, current_period_end, last_event_created)
select id, 'sub_demo_seed_bella', 'active', 'price_demo_seed', now() + interval '30 days', 0
from public.restaurants
where name = 'Bella Italia'
on conflict (stripe_subscription_id) do nothing;
