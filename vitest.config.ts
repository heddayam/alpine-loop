import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: {
    environment: "node",
    // Integration fixtures launch their own solver and SQLite worker processes.
    maxWorkers: 1,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "legacy/**"],
  },
});
