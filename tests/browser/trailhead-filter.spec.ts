import { expect, test } from "@playwright/test";
import { REACHABILITY_ID } from "./fixtures";
import { enterDrawnArea, installOfflineHarness, SEARCH_REGION, selectTypedOrigin } from "./offline-harness";

test("one builder keeps both search actions visible and runs drawn Quick search explicitly", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("Driving origin", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Typical drive time")).toHaveValue("30");
  await expect(page.getByLabel("Broad region")).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Full search" })).toBeVisible();
  await enterDrawnArea(page);
  expect(harness.generationRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.generationRequests[0]).toMatchObject({ version: 3, searchEffort: "quick", accessFilter: { mode: "drawn-area", bbox: [-122.183, 37.155, -122.14, 37.178] } });
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Quick-search routes")).toHaveValue("10");
  await expect(page.getByLabel("Search effort")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("drive-time Quick search resolves reachability and applies the curated region", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await selectTypedOrigin(page);
  await page.getByLabel("Broad region").selectOption(SEARCH_REGION.id);
  await page.getByRole("button", { name: "Quick search" }).click();

  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.reachabilityRequests[0]).toMatchObject({ version: 1, packId: "fixture-pack", durationMinutes: 30, origin: { label: "Castle Rock, California" } });
  expect(harness.calls).toContainEqual(expect.objectContaining({ method: "GET", pathname: `/api/reachability/${REACHABILITY_ID}` }));
  expect(harness.generationRequests[0]).toMatchObject({
    version: 3,
    searchEffort: "quick",
    accessFilter: { mode: "drive-time", reachabilityId: REACHABILITY_ID, regionId: SEARCH_REGION.id },
    accessPointRemoteness: ["remote", "unknown"],
  });
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("Batch launches a persistent job and reopens its saved result page", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await selectTypedOrigin(page);
  await expect(page.getByLabel("Typical drive time")).toHaveValue("30");
  await page.getByLabel("Broad region").selectOption(SEARCH_REGION.id);
  await page.getByRole("button", { name: "Full search" }).click();

  const jobs = page.getByRole("dialog", { name: "Jobs" });
  await expect(jobs).toBeVisible();
  await expect(jobs.getByText("Completed", { exact: true })).toBeVisible();
  expect(harness.batchRequests[0]).toMatchObject({ version: 1, packId: "fixture-pack", durationMinutes: 30, searchRegionId: SEARCH_REGION.id, routesPerAccessPoint: 10, criteria: { accessPointRemoteness: ["remote", "unknown"], includeUncertainAccess: true } });
  expect(harness.batchRequests[0]).not.toHaveProperty("startAccessPointId");
  expect(harness.batchRequests[0]).not.toHaveProperty("searchEffort");

  await jobs.getByRole("button", { name: "View results" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await expect(page.locator(".route-card")).toHaveCount(2);
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
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
  const results = page.locator(".results-panel");
  await expect.poll(() => results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(harness.blockedExternalRequests).toEqual([]);
});
