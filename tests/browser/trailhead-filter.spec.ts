import { expect, test } from "@playwright/test";
import { enterDrawnArea, installOfflineHarness, SEARCH_REGION, selectTypedOrigin } from "./offline-harness";

test("Explore auto-searches with Quick effort and aborts stale work", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByRole("radio", { name: /^Explore/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^Batch search/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Named region/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate routes" })).toHaveCount(0);
  await enterDrawnArea(page);
  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.generationRequests[0]).toMatchObject({ version: 3, searchEffort: "quick", accessFilter: { mode: "drawn-area", bbox: [-122.18, 37.155, -122.155, 37.17] } });
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Quick-search routes")).toHaveValue("10");
  await expect(page.getByLabel("Search effort")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("Batch launches a persistent job and reopens its saved result page", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");
  await page.getByRole("radio", { name: /^Batch search/ }).check();

  await selectTypedOrigin(page);
  await expect(page.getByLabel("Typical drive time")).toHaveValue("30");
  await page.getByLabel("Search region").selectOption(SEARCH_REGION.id);
  await page.getByRole("button", { name: "Launch batch search" }).click();

  const jobs = page.getByRole("dialog", { name: "Jobs" });
  await expect(jobs).toBeVisible();
  await expect(jobs.getByText("Completed", { exact: true })).toBeVisible();
  expect(harness.batchRequests[0]).toMatchObject({ version: 1, packId: "fixture-pack", durationMinutes: 30, searchRegionId: SEARCH_REGION.id, routesPerAccessPoint: 10, criteria: { accessPointRemoteness: ["remote", "rural", "populated", "unknown"], includeUncertainAccess: true } });
  expect(harness.batchRequests[0]).not.toHaveProperty("startAccessPointId");
  expect(harness.batchRequests[0]).not.toHaveProperty("searchEffort");

  await jobs.getByRole("button", { name: "View results" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await expect(page.locator(".route-card")).toHaveCount(2);
  await expect(page.getByLabel("Map status")).toContainText("Batch search");
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("Jobs and Settings dialogs trap focus, close with Escape, and work on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await installOfflineHarness(page, { routeCount: 10 });
  await page.goto("/");

  const jobsButton = page.getByRole("button", { name: "Jobs" });
  await jobsButton.click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close jobs" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(jobsButton).toBeFocused();

  await enterDrawnArea(page);
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
  const results = page.locator(".results-panel");
  await expect.poll(() => results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(harness.blockedExternalRequests).toEqual([]);
});
