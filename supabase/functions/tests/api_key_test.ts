/**
 * Key selection for the legacy → publishable/secret migration: the new key
 * dictionary must win whenever the runtime provides it, otherwise disabling
 * the legacy keys in the dashboard would break every Edge Function.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { apiKey } from "../_shared/db.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  try {
    for (const [k, v] of Object.entries(vars)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
}

Deno.test("new secret key dictionary wins over legacy service_role", () => {
  withEnv({
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_new" }),
    SUPABASE_SERVICE_ROLE_KEY: "legacy-jwt",
  }, () => {
    assertEquals(
      apiKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
      "sb_secret_new",
    );
  });
});

Deno.test("non-default key name is used when default is absent", () => {
  withEnv({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ web: "sb_publishable_web" }),
    SUPABASE_ANON_KEY: "legacy-anon",
  }, () => {
    assertEquals(
      apiKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
      "sb_publishable_web",
    );
  });
});

Deno.test("falls back to legacy key when dictionary is missing or malformed", () => {
  for (const dict of [undefined, "not-json", "{}"]) {
    withEnv({
      SUPABASE_SECRET_KEYS: dict,
      SUPABASE_SERVICE_ROLE_KEY: "legacy-jwt",
    }, () => {
      assertEquals(
        apiKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
        "legacy-jwt",
      );
    });
  }
});

Deno.test("no key at all is a configuration error", () => {
  withEnv({
    SUPABASE_SECRET_KEYS: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
  }, () => {
    assertThrows(
      () => apiKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
      Error,
      "SUPABASE_SERVICE_ROLE_KEY_not_configured",
    );
  });
});
