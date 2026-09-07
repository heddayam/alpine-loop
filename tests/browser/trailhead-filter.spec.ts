import { expect, test } from "@playwright/test";
import { ACCESS_POINTS, routeResponse } from "./fixtures";
import { enterDrawnArea, installOfflineHarness, SEARCH_REGION, selectRegion, selectTypedOrigin } from "./offline-harness";

test("one builder runs Quick and Full search from the drawn boundary", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("Driving origin", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Typical drive time")).toHaveValue("30");
  await selectRegion(page);
  const regions = page.getByRole("button", { name: `Regions: ${SEARCH_REGION.name}` });
  await expect(regions).toBeVisible();
  await regions.click();
  await expect(page.getByRole("group", { name: "Region selection" }).getByRole("checkbox", { name: SEARCH_REGION.name })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Quick search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Full search" })).toBeVisible();
  const drawnBounds = await enterDrawnArea(page);
  await expect(page.getByText("An area selects starting points. Your hike can continue beyond it within installed coverage.")).toBeVisible();
  expect(harness.generationRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.generationRequests[0]?.area.mode).toBe("drawn-area");
  if (harness.generationRequests[0]?.area.mode === "drawn-area") harness.generationRequests[0].area.bbox.forEach((value, index) => expect(value).toBeCloseTo(drawnBounds[index]!, 4));
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  const firstCard = page.locator(".route-card").first();
  await expect(firstCard.getByRole("button", { name: /Stevens Creek Trailhead.*Canyon Trail 1/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Trail segments" })).toHaveCount(0);
  await firstCard.getByRole("button", { name: /Stevens Creek Trailhead.*Canyon Trail 1/ }).click();
  await expect(firstCard.getByRole("region", { name: "Trail segments" })).toBeVisible();
  const firstSegment = firstCard.getByRole("button", { name: /1.7 mi.*Canyon Trail 1/i });
  await firstSegment.hover();
  await expect(firstSegment).toHaveClass(/hovered/);
  await firstSegment.click();
  await expect(firstSegment).toHaveAttribute("aria-pressed", "true");
  const conditionSearch = firstCard.getByRole("link", { name: "Search Google for Canyon Trail 1 conditions" });
  await expect(conditionSearch).toHaveAttribute("href", "https://www.google.com/search?q=Canyon%20Trail%201%20conditions");
  await expect(conditionSearch).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: "Back to results" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();

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

  await page.getByRole("button", { name: "Full search" }).click();
  const jobs = page.getByRole("dialog", { name: "Jobs" });
  await expect(jobs).toBeVisible();
  await expect(jobs.getByText("Drawn boundary")).toBeVisible();
  expect(harness.batchRequests).toHaveLength(1);
  expect(harness.batchRequests[0]?.area).toEqual(harness.generationRequests[0]?.area);
  expect(harness.batchRequests[0]?.criteria.includeUncertainAccess).toBe(true);
  expect(harness.batchRequests[0]).not.toHaveProperty("packId");
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("drive-time Quick search sends one geographic request with named refinements", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await selectTypedOrigin(page);
  await selectRegion(page);
  await expect(page.getByRole("button", { name: `Regions: ${SEARCH_REGION.name}` })).toBeVisible();
  await page.getByRole("button", { name: "Quick search" }).click();

  await expect.poll(() => harness.generationRequests.length).toBe(1);
  expect(harness.calls.some(({ pathname }) => pathname.includes("reachability"))).toBe(false);
  expect(harness.generationRequests[0]?.area).toMatchObject({ mode: "drive-time", regionIds: [SEARCH_REGION.id], durationMinutes: 30, origin: { label: "Castle Rock, California" } });
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("Full search launches a persistent region-wide job without an origin and reopens its results", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await selectRegion(page);
  await expect(page.getByLabel("Driving origin", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: `Regions: ${SEARCH_REGION.name}` })).toBeVisible();
  await page.getByRole("button", { name: "Full search" }).click();

  const jobs = page.getByRole("dialog", { name: "Jobs" });
  await expect(jobs).toBeVisible();
  await expect(jobs.getByText("Completed", { exact: true })).toBeVisible();
  await expect(jobs.getByText("Named regions")).toBeVisible();
  expect(harness.batchRequests[0]).toMatchObject({ area: { mode: "named-regions", regionIds: [SEARCH_REGION.id] }, criteria: { includeUncertainAccess: true } });
  expect(harness.batchRequests[0]).not.toHaveProperty("packId");

  await jobs.getByRole("button", { name: /View results for/ }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await expect(page.locator(".route-card")).toHaveCount(2);
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("native trailhead counts open a filtered list and preserve route numbering", async ({ page }) => {
  const harness = await installOfflineHarness(page, { routeCount: 10 });
  await page.goto("/");
  await enterDrawnArea(page);
  const framed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/map");
  await page.getByRole("button", { name: "Quick search" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await framed;
  await expect(page.locator(".maplibregl-marker")).toHaveCount(0);

  // Project the fixture's real start against the documented 64px result framing,
  // independent of the native marker implementation or any private map instance.
  const mercator = ([lon, lat]: number[]) => [
    (lon! + 180) / 360,
    .5 - Math.log(Math.tan(Math.PI / 4 + lat! * Math.PI / 360)) / (2 * Math.PI),
  ];
  const response = routeResponse(harness.generationRequests[0]!, 10);
  const points = response.exact.flatMap((route) => route.geometry.coordinates.map(mercator));
  const xs = points.map(([x]) => x!), ys = points.map(([, y]) => y!);
  const west = Math.min(...xs), east = Math.max(...xs), north = Math.min(...ys), south = Math.max(...ys);
  const box = (await page.locator(".maplibregl-canvas").boundingBox())!;
  const scale = Math.min((box.width - 128) / (east - west), (box.height - 128) / (south - north), 512 * 2 ** 14);
  const [x, y] = mercator([ACCESS_POINTS[0]!.lon, ACCESS_POINTS[0]!.lat]);
  const start = { x: box.x + box.width / 2 + (x! - (west + east) / 2) * scale, y: box.y + box.height / 2 + (y! - (north + south) / 2) * scale };
  await page.mouse.move(start.x, start.y);
  await expect(page.locator(".map-trail-label")).toContainText("5 routes");
  await page.mouse.click(start.x, start.y);
  await expect(page.locator(".start-filter")).toContainText("Stevens Creek Trailhead");
  await expect(page.locator(".route-card")).toHaveCount(5);
  await expect(page.locator(".route-number")).toHaveText(["1", "3", "5", "7", "9"]);
  await expect(page.getByRole("complementary", { name: "Route details" })).toHaveCount(0);
  await page.locator(".route-card-select").nth(2).click();
  await expect(page.locator(".route-number")).toHaveText(["5"]);
  await page.getByRole("button", { name: /Back to results/ }).click();
  await expect(page.locator(".route-card")).toHaveCount(5);
  await page.getByRole("button", { name: "All trailheads" }).click();
  await expect(page.locator(".route-card")).toHaveCount(10);
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("Jobs and Settings dialogs trap focus, close with Escape, and work on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await installOfflineHarness(page, { routeCount: 10 });
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Region packs" })).toHaveCount(0);
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
  expect(harness.generationRequests[0]?.criteria.gradeExperience).toMatchObject({ maximumClimbP90Pct: 13 });
  expect(harness.blockedExternalRequests).toEqual([]);
});


test("one panel preserves the draft and selection while switching map and route detail", async ({ page }) => {
  const harness = await installOfflineHarness(page, { routeCount: 10 });
  await page.goto("/");
  await page.getByLabel("Routes to find").selectOption("3");
  await enterDrawnArea(page);
  await page.getByRole("button", { name: "Quick search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  expect(harness.generationRequests[0]?.limit).toBe(3);
  await expect(page.getByLabel("Distance minimum")).toBeHidden();
  await page.locator(".route-card-select").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".route-card-select").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".route-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Back to results" })).toBeFocused();
  await page.getByRole("button", { name: "Back to results" }).click();
  await expect(page.locator(".route-card-select").nth(1)).toBeFocused();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByLabel("Distance minimum").fill("2");
  await page.getByRole("button", { name: /^Results \(/ }).click();
  await expect(page.getByText(/Viewing .*1–4 mi/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show map" }).click();
  await expect(page.getByRole("region", { name: "Route planner" })).toBeHidden();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Show panel" }).click();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByLabel("Distance minimum")).toHaveValue("2");
  expect(harness.blockedExternalRequests).toEqual([]);
});
