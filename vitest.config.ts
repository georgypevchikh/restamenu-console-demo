import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    // Database suites are deliberately explicit. `npm test` stays hermetic
    // and never mutates a shared Supabase project by accident.
    exclude: [
      "tests/tenant-isolation.test.ts",
      "tests/billing-isolation.test.ts",
      "**/node_modules/**",
      "**/.git/**",
    ],
  },
});
