/** OTP primitives — WebCrypto is available in Node ≥20 and Deno alike. */

import { describe, it, expect } from "vitest";
import {
  generateOtpCode,
  generateSalt,
  hashOtpCode,
  verifyOtpCode,
  timingSafeEqualHex,
} from "../supabase/functions/_shared/core/otp-core.ts";

describe("generateOtpCode", () => {
  it("always six digits, and not constant", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(150); // collisions allowed, constancy is not
  });
});

describe("hash / verify round trip", () => {
  it("verifies the right code and rejects the wrong one", async () => {
    const salt = generateSalt();
    const hash = await hashOtpCode("123456", salt);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyOtpCode("123456", salt, hash)).toBe(true);
    expect(await verifyOtpCode("123457", salt, hash)).toBe(false);
  });

  it("same code, different salt → different hash", async () => {
    const h1 = await hashOtpCode("123456", generateSalt());
    const h2 = await hashOtpCode("123456", generateSalt());
    expect(h1).not.toBe(h2);
  });

  it("rejects non-6-digit input without touching the hash", async () => {
    const salt = generateSalt();
    const hash = await hashOtpCode("123456", salt);
    expect(await verifyOtpCode("12345", salt, hash)).toBe(false);
    expect(await verifyOtpCode("abcdef", salt, hash)).toBe(false);
    expect(await verifyOtpCode("1234567", salt, hash)).toBe(false);
  });
});

describe("timingSafeEqualHex", () => {
  it("compares correctly", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
  });
});
