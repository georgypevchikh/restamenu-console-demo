import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
const retention = fs.readFileSync(
  path.join(migrationsDir, "029_cron_history_retention.sql"),
  "utf8",
);
const everyMinuteJobs = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .flatMap((f) =>
    [...fs.readFileSync(path.join(migrationsDir, f), "utf8").matchAll(
      /cron\.schedule\(\s*'([^']+)',\s*'\* \* \* \* \*'/g,
    )].map((m) => m[1]),
  );

describe("pg_cron history retention", () => {
  it("exists whenever a job runs every minute", () => {
    expect(everyMinuteJobs.length).toBeGreaterThan(0);
    expect(retention).toMatch(/cron\.schedule\(\s*'purge-cron-history'/);
  });

  it("only deletes scheduler history older than a bounded window", () => {
    expect(retention).toMatch(
      /delete from cron\.job_run_details where end_time < now\(\) - interval '\d+ days'/,
    );
    expect(retention).not.toMatch(/delete from (public|auth|storage)\./);
  });

  it("is idempotent on re-apply", () => {
    const unschedule = retention.indexOf("cron.unschedule");
    const schedule = retention.indexOf("cron.schedule(");
    expect(unschedule).toBeGreaterThanOrEqual(0);
    expect(unschedule).toBeLessThan(schedule);
  });
});
