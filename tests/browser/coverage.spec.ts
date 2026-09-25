import { expect, test } from "@playwright/test";
import { catalog as fixtureCatalog, job as fixtureJob, request } from "../fixtures/coverage/catalog";
import { installOfflineHarness } from "./offline-harness";

for (const width of [1280, 390]) test(`coverage can be downloaded and paused at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const harness = await installOfflineHarness(page);
  const catalog = structuredClone(fixtureCatalog), job = structuredClone(fixtureJob);
  await page.route("**/api/coverage**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/pause")) { job.status = "paused"; await route.fulfill({ json: job }); }
    else if (path.endsWith("/jobs")) { expect(route.request().postDataJSON()).toEqual(request); catalog.jobs = [job]; await route.fulfill({ json: job }); }
    else await route.fulfill({ json: catalog });
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Coverage", exact: true });
  await trigger.click();
  const dialog = page.getByRole("complementary", { name: "Manage coverage" });
  await expect(dialog).toBeVisible();
  if (width <= 600) await page.getByRole("button", { name: "Show map", exact: true }).click();
  const canvas = page.locator(".maplibregl-canvas");
  await expect(async () => {
    await canvas.hover();
    await expect(canvas).toHaveCSS("cursor", "pointer");
  }).toPass({ timeout: 10000 });
  await canvas.click();
  if (width <= 600) await page.getByRole("button", { name: "Show panel", exact: true }).click();
  await expect(dialog.getByText(/1 section selected/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw trailhead filter" })).not.toBeVisible();
  await expect(dialog.getByText(/256 KiB/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("coverage.png") });
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Back to planning" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});
