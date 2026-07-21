import { describe, expect, it } from "vitest";
import { errorJson, json } from "../supabase/functions/_shared/http.ts";

describe("Edge Function JSON responses", () => {
  it.each([
    json(200, { ok: true }),
    errorJson(400, "bad_request"),
    errorJson(500, "internal_error"),
  ])(
    "is JSON, non-cacheable and protected from content sniffing",
    (response) => {
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );
});
