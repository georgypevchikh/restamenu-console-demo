import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const initialMigration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/024_po_otp_security.sql"),
  "utf8",
);
const hardeningMigration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "supabase/migrations/026_database_trust_boundaries.sql",
  ),
  "utf8",
);
const migration = `${initialMigration}\n${hardeningMigration}`;
const endpoint = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/functions/otp-request/index.ts"),
  "utf8",
);

describe("atomic OTP issuance contract", () => {
  it("serializes identity, tenant, phone and IP buckets before inserting", () => {
    const fnStart = migration.lastIndexOf(
      "create or replace function public.issue_otp_challenge",
    );
    const fnEnd = migration.indexOf(
      "create or replace function public.queue_urgent_request",
      fnStart,
    );
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);

    const fn = migration.slice(fnStart, fnEnd);
    const restaurantLock = fn.indexOf(
      "hashtextextended('otp-restaurant:' || p_restaurant_id::text",
    );
    const userLock = fn.indexOf(
      "hashtextextended('otp-user:' || p_user_id::text",
    );
    const phoneLock = fn.indexOf("hashtextextended('otp-phone:' || v_phone");
    const ipLock = fn.indexOf("hashtextextended('otp-ip:' || v_ip");
    const insert = fn.indexOf("insert into public.otp_challenges");

    expect(restaurantLock).toBeGreaterThan(-1);
    expect(userLock).toBeGreaterThan(restaurantLock);
    expect(phoneLock).toBeGreaterThan(userLock);
    expect(ipLock).toBeGreaterThan(phoneLock);
    expect(insert).toBeGreaterThan(ipLock);
    expect(fn).toContain("v_user_hour >= 5");
    expect(fn).toContain("'user_hourly_limit'::text");
    expect(fn).toContain("v_restaurant_hour >= 20");
    expect(fn).toContain("'restaurant_hourly_limit'::text");
    expect(fn).toContain("v_phone_hour >= 5");
    expect(fn).toContain("v_ip_hour >= 10");
  });

  it("exposes issuance to service_role only", () => {
    const signature =
      "public.issue_otp_challenge(uuid, uuid, text, text, text, uuid, text, text, timestamptz, text, text)";
    expect(migration).toContain(
      `revoke execute on function ${signature} from public, anon, authenticated;`,
    );
    expect(migration).toContain(
      `grant execute on function ${signature} to service_role;`,
    );
  });

  it("uses the atomic RPC and handles post-send persistence failures", () => {
    expect(endpoint).toMatch(/db\.rpc\(\s*["']issue_otp_challenge["']/);
    expect(endpoint).not.toMatch(/db\.rpc\(\s*["']check_otp_rate_limit["']/);
    expect(endpoint).not.toMatch(/from\("otp_challenges"\)[\s\S]*?\.insert/);
    expect(endpoint).toContain("if (messageIdError) return internalError");
    expect(endpoint).toContain("if (auditError) return internalError");
  });
});
