-- pg_cron drives the transactional-outbox sweeps (migration 015). pg_net is
-- already enabled (migration 011 uses it for the urgent-request webhook).
create extension if not exists pg_cron;
