import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const browserPort = 3101;
const appRoot = process.env.ALPINE_QA_APP_ROOT
  ?? fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${browserPort}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run dev -- --port ${browserPort}`,
    cwd: appRoot,
    url: `http://127.0.0.1:${browserPort}`,
    reuseExistingServer: false,
    env: {
      ...process.env,
      ALPINE_PACK_ROOT: path.join(tmpdir(), "alpine-search-playwright-empty-packs"),
      ALPINE_NEXT_DIST_DIR: ".next-playwright",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
