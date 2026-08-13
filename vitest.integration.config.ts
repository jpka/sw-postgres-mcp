import { defineConfig } from "vitest/config";

// Every test under tests/ already runs against a live Postgres (see
// tests/helpers.ts), so "integration" and the default suite are the same set
// of tests today. This file exists so `npm run test:integration` (long
// referenced from package.json but never backed by a config) actually runs
// instead of failing to resolve its --config path.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    environment: "node",
  },
});
