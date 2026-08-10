import { expect, test } from "@playwright/test";
import { REACHABILITY_ID } from "./fixtures";
import { enterDrawnArea, installOfflineHarness, SEARCH_REGION, selectTypedOrigin } from "./offline-harness";

test("one builder keeps both search actions visible and runs drawn Quick search explicitly", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("Driving origin", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Typical drive time")).toHaveValue("30");
  const regions = page.getByRole("button", { name: `Regions: ${SEARCH_REGION.name}` });
  await expect(regions).toBeVisible();
  await regions.click();
  await expect(page.getByRole("group", { name: "Fixture pack" }).getByRole("checkbox", { name: SEARCH_REGION.name })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Quick search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Full search" })).toBeVisible();
  await enterDrawnArea(page);
  expect(harness.generationRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.generationRequests[0]).toMatchObject({ version: 3, searchEffort: "quick", accessFilter: { mode: "drawn-area", bbox: [-122.183, 37.155, -122.14, 37.178] } });
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  const firstCard = page.locator(".route-card").first();
  await expect(firstCard.getByRole("button", { name: /Stevens Creek Trailhead.*Canyon Trail 1/ })).toBeVisible();
  await expect(firstCard.getByRole("region", { name: "Trail segments" })).toBeVisible();
  const firstSegment = firstCard.getByRole("button", { name: /1.7 mi.*Canyon Trail 1/i });
  await firstSegment.hover();
  await expect(firstSegment).toHaveClass(/hovered/);
  await firstSegment.click();
  await expect(firstSegment).toHaveAttribute("aria-pressed", "true");
  const conditionSearch = firstCard.getByRole("link", { name: "Search Google for Canyon Trail 1 conditions" });
  await expect(conditionSearch).toHaveAttribute("href", "https://www.google.com/search?q=Canyon%20Trail%201%20conditions");
  await expect(conditionSearch).toHaveAttribute("target", "_blank");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Quick-search routes")).toHaveValue("10");
  const regionBoundarySwitch = page.getByRole("switch", { name: "Show region boundaries" });
  await expect(regionBoundarySwitch).not.toBeChecked();
  await regionBoundarySwitch.click();
  await expect(regionBoundarySwitch).toBeChecked();
  await expect(page.getByLabel("Search effort")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear results" }).click();
  await expect(page.getByRole("heading", { name: "Results" })).toHaveCount(0);
  await expect(page.locator(".route-pin")).toHaveCount(0);
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("drive-time Quick search resolves reachability and applies the curated region", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await selectTypedOrigin(page);
  await expect(page.getByRole("button", { name: `Regions: ${SEARCH_REGION.name}` })).toBeVisible();
  await page.getByRole("button", { name: "Quick search" }).click();

  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.reachabilityRequests[0]).toMatchObject({ version: 1, packId: "fixture-pack", durationMinutes: 30, origin: { label: "Castle Rock, California" } });
  expect(harness.calls).toContainEqual(expect.objectContaining({ method: "GET", pathname: `/api/reachability/${REACHABILITY_ID}` }));
  expect(harness.generationRequests[0]).toMatchObject({
    version: 3,
    searchEffort: "quick",
    accessFilter: { mode: "drive-time", reachabilityId: REACHABILITY_ID, regionId: SEARCH_REGION.id },
  });
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("Full search launches a persistent region-wide job without an origin and reopens its results", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByLabel("Driving origin", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: `Regions: ${SEARCH_REGION.name}` })).toBeVisible();
  await page.getByRole("button", { name: "Full search" }).click();

  const jobs = page.getByRole("dialog", { name: "Jobs" });
  await expect(jobs).toBeVisible();
  await expect(jobs.getByText("Completed", { exact: true })).toBeVisible();
  await expect(jobs.getByText("Entire reviewed region")).toBeVisible();
  expect(harness.batchRequests[0]).toMatchObject({ version: 1, packId: "fixture-pack", searchRegionId: SEARCH_REGION.id, routesPerAccessPoint: 10, criteria: { includeUncertainAccess: true } });
  expect(harness.batchRequests[0]).not.toHaveProperty("origin");
  expect(harness.batchRequests[0]).not.toHaveProperty("durationMinutes");
  expect(harness.batchRequests[0]).not.toHaveProperty("startAccessPointId");
  expect(harness.batchRequests[0]).not.toHaveProperty("searchEffort");
  expect(harness.reachabilityRequests).toHaveLength(0);

  await jobs.getByRole("button", { name: "View results" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await expect(page.locator(".route-card")).toHaveCount(2);
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("shared result starts anchor precisely and reveal route numbers at trail zoom", async ({ page }) => {
  const harness = await installOfflineHarness(page, { routeCount: 10 });
  await page.goto("/");

  await enterDrawnArea(page);
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();

  const expandedPins = page.locator(".route-pin-expanded");
  await expect(expandedPins).toHaveCount(2);
  const numberedPins = expandedPins.locator(".route-pin");
  await expect(numberedPins).toHaveCount(10);
  await expect(numberedPins).toHaveText(["1", "3", "5", "7", "9", "2", "4", "6", "8", "10"]);
  const anchors = await expandedPins.evaluateAll((groups) => groups.map((group) => {
    const anchor = group.getBoundingClientRect();
    const tip = group.querySelector<HTMLElement>(".route-pin-tip")!.getBoundingClientRect();
    return Math.abs((tip.left + tip.width / 2) - (anchor.left + anchor.width / 2)) < 0.5
      && Math.abs(tip.bottom - anchor.bottom) < 0.5;
  }));
  expect(anchors).toEqual([true, true]);
  const visuals = await numberedPins.evaluateAll((pins) => pins.map((pin) => {
    const marker = pin.getBoundingClientRect();
    const style = getComputedStyle(pin);
    return {
      contained: marker.width >= marker.height,
      whiteSpace: style.whiteSpace,
    };
  }));
  expect(visuals.every(({ contained, whiteSpace }) => contained && whiteSpace === "nowrap")).toBe(true);
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
