-- Keep pg_cron run history bounded.
--
-- process-outbox and reconcile-outbox run every minute, so pg_cron writes
-- ~2,900 rows/day into cron.job_run_details and never deletes them. By
-- 2026-09-23 that was 185k rows / 29 MB of a 43 MB database — most of the
-- free-tier footprint was scheduler logs. Keep seven days for debugging.

select cron.unschedule(jobid) from cron.job where jobname = 'purge-cron-history';

select cron.schedule(
  'purge-cron-history',
  '23 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
