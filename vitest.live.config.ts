import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      "tests/tenant-isolation.test.ts",
      "tests/billing-isolation.test.ts",
    ],
    // The suites share seeded identities and intentionally mutate a small
    // amount of state. Serial files make auth limits and cleanup deterministic.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
