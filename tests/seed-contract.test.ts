import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isUuid } from "../lib/uuid";

const LEGACY_TENANT_IDS = new Set([
  "11111111-0000-0000-0000-000000000001",
  "22222222-0000-0000-0000-000000000002",
]);

describe("deterministic local seed", () => {
  it("uses application-valid UUIDs for every UI-selectable entity", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/seed-local-test-data.mjs"),
      "utf8",
    );
    const ids = [
      ...source.matchAll(
        /["']([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})["']/gi,
      ),
    ].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids) {
      if (!LEGACY_TENANT_IDS.has(id)) {
        expect(isUuid(id), id).toBe(true);
      }
    }
  });
});
