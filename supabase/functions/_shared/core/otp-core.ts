/**
 * OTP primitives: code generation, HMAC hashing, constant-time comparison.
 * Uses only WebCrypto (globalThis.crypto), which Node ≥20 and Deno both
 * provide, so the same file is tested in both runtimes.
 *
 * The code is 6 digits from a CSPRNG. What lands in the database is
 * HMAC-SHA256(code) keyed with a per-challenge random salt — never the code.
 */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateOtpCode(): string {
  // Rejection sampling over 32-bit words: no modulo bias.
  const max = 1_000_000;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return String(value % max).padStart(6, "0");
}

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashOtpCode(code: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(code),
  );
  return bytesToHex(new Uint8Array(sig));
}

/** Constant-time hex comparison — no early exit on first mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyOtpCode(
  code: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const actual = await hashOtpCode(code, salt);
  return timingSafeEqualHex(actual, expectedHash);
}
