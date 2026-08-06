import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: {
    environment: "node",
    maxWorkers: 2,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "legacy/**"],
  },
});
