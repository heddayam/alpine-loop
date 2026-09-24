import { expect, test } from "@playwright/test";
import type { CoverageCatalog, CoverageJob, CoveragePlan } from "../../lib/contracts/coverage";
import { installOfflineHarness } from "./offline-harness";

for (const width of [1280, 390]) test(`coverage can be planned and paused at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const harness = await installOfflineHarness(page);
  const geometry: CoveragePlan["geometry"] = { type: "Polygon", coordinates: [[[-122, 47], [-121, 47], [-121, 48], [-122, 48], [-122, 47]]] };
  const plan: CoveragePlan = { id: "plan", request: { collectionIds: ["cascades"], memoryLimitMiB: 4096, offline: false }, geometry, sourceIds: ["osm"], units: [{ id: "unit", geometry, status: "pending" }], estimates: { downloadBytes: null, temporaryBytes: null, reusableBytes: 0 }, warnings: [] };
  const catalog: CoverageCatalog = { collections: [{ id: "cascades", name: "Washington Cascades", geometry, sourceIds: ["osm"], limitations: [] }], installed: null, jobs: [], prerequisites: [] };
  const job: CoverageJob = { id: "job", plan, status: "running", stage: "Preparing trails", completedUnits: 0, totalUnits: 1, createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", error: null, snapshot: null };
  await page.route("**/api/coverage**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/plan")) { expect(route.request().postDataJSON()).toEqual(plan.request); await route.fulfill({ json: plan }); }
    else if (path.endsWith("/pause")) { job.status = "paused"; await route.fulfill({ json: job }); }
    else if (path.endsWith("/jobs")) { catalog.jobs = [job]; await route.fulfill({ json: job }); }
    else await route.fulfill({ json: catalog });
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Coverage", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Manage coverage" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Washington Cascades").check();
  await dialog.getByRole("button", { name: "Preview installation" }).click();
  await expect(dialog.getByText("Unknown until sources are checked")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Start installation" }).click();
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(harness.blockedExternalRequests).toEqual([]);
});
