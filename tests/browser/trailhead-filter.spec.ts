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

  const regionStrip = page.getByRole("navigation", { name: "Region packs" });
  await expect(regionStrip.locator(".region-pill > span:not(.visually-hidden)")).toHaveText([
    "Santa Cruz Mountains",
    "Southern East Bay",
    "Monterey–Carmel",
    "Henry Coe",
    "Marin & Mount Tam",
    "Tahoe–Eldorado",
  ]);
  const plannedRegion = regionStrip.locator(".region-pill").filter({ hasText: "Southern East Bay" });
  await expect(plannedRegion).toBeDisabled();
  await expect(plannedRegion.locator(".status-dot")).toHaveCount(0);
  await expect.poll(() => regionStrip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(() => regionStrip.evaluate((element) => element.clientWidth)).toBeGreaterThan(300);
  await expect(page.getByRole("button", { name: "Jobs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();

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

test("grade and loop defaults persist across reloads", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByLabel("Selected climbing grade")).toHaveText("12%");
  await page.getByRole("button", { name: "Grade preset definitions" }).hover();
  await expect(page.getByRole("tooltip").getByRole("row", { name: /Moderate 12% 20% 0.5 mi 15%/ })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Moderate climb grade").fill("13");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Done" }).click();
  await expect.poll(() => harness.settingsRequests.at(-1)?.gradePresets.moderate.maximumClimbP90Pct).toBe(13);

  await page.getByText("Loop options", { exact: true }).click();
  await page.getByLabel("Maximum repeated trail").fill("20");
  await page.getByLabel("Maximum repeated trail").press("Tab");
  await page.getByRole("checkbox", { name: "Shared approach" }).check();
  await page.getByLabel("Maximum shared approach").fill("1.2");
  await page.getByLabel("Maximum shared approach").press("Tab");
  await page.getByRole("switch", { name: /Allow figure-eights/ }).uncheck();
  await expect.poll(() => harness.settingsRequests.at(-1)?.loopOptions).toEqual({ maximumRepeatedTrailPct: 20, sharedApproachEnabled: true, maximumSharedApproachMiles: 1.2, allowMultiCycle: false });

  await page.reload();
  await expect(page.getByLabel("Selected climbing grade")).toHaveText("13%");
  await page.getByText("Loop options", { exact: true }).click();
  await expect(page.getByLabel("Maximum repeated trail")).toHaveValue("20");
  await expect(page.getByRole("checkbox", { name: "Shared approach" })).toBeChecked();
  await expect(page.getByLabel("Maximum shared approach")).toHaveValue("1.2");
  await expect(page.getByRole("switch", { name: /Allow figure-eights/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Grade" }).check();
  await enterDrawnArea(page);
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.generationRequests[0]?.gradeExperience).toMatchObject({ maximumClimbP90Pct: 13 });
  expect(harness.blockedExternalRequests).toEqual([]);
});
