import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: {
    environment: "node",
    // Integration fixtures launch their own solver and SQLite worker processes.
    maxWorkers: 1,
    // Native integration work needs scheduling headroom on a busy host.
    // Performance acceptance is asserted separately by the relevant fixtures.
    testTimeout: 30_000,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "legacy/**"],
  },
});
