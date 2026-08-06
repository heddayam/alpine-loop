import { expect, test, type Page } from "@playwright/test";
import type { GenerateClosedRoutesRequestV3 } from "../../lib/contracts";
import {
  FILTER_GEOMETRY,
  NAMED_AREA,
  PACK_COVERAGE,
  pointInsideArea,
  routeResponse,
} from "./fixtures";
import {
  calculateDriveArea,
  enterDrawnArea,
  installOfflineHarness,
  selectNamedRegionWithKeyboard,
  selectTypedOrigin,
} from "./offline-harness";

async function chooseMode(page: Page, name: "Draw area" | "Named region" | "Drive time") {
  await page.getByRole("radio", { name: new RegExp(`^${name}`) }).check();
}

async function generate(page: Page) {
  await page.getByRole("button", { name: "Generate routes" }).click();
  await expect(page.getByRole("heading", { name: "Results", exact: true })).toBeVisible();
}

test("draw and named-region modes preserve drafts and send V3 closed-route settings", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  await expect(page.getByRole("radio", { name: /^Draw area/ })).toBeChecked();
  await expect(page.getByText("Highlighted areas filter trailheads, not route geometry.", { exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Maximum repeated trail" })).toHaveValue("35");
  await expect(page.getByRole("switch", { name: /Allow figure-eights and chained loops/ })).toBeChecked();
  await expect(page.getByLabel("Search effort")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Search effort")).toHaveValue("thorough");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("checkbox", { name: /^Out & back/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^Point to point/ })).toHaveCount(0);
  await enterDrawnArea(page);
  await generate(page);
  expect(harness.generationRequests.at(-1)).toMatchObject({
    version: 3,
    routeFamily: "closed",
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    accessPointRemoteness: ["remote", "rural", "populated", "unknown"],
    searchEffort: "thorough",
    accessFilter: {
      mode: "drawn-area",
      bbox: [-122.18, 37.155, -122.155, 37.17],
    },
  });

  await chooseMode(page, "Named region");
  await expect(page.getByRole("heading", { name: "Results", exact: true })).toHaveCount(0);
  await selectNamedRegionWithKeyboard(page);
  await expect(page.getByRole("combobox", { name: "Access point", exact: true })).toBeVisible();
  await generate(page);
  expect(harness.generationRequests.at(-1)).toMatchObject({
    version: 3,
    routeFamily: "closed",
    accessFilter: { mode: "named-region", regionId: NAMED_AREA.id },
  });

  await chooseMode(page, "Draw area");
  await expect(page.getByLabel("West longitude")).toHaveValue("-122.18");
  await chooseMode(page, "Named region");
  await expect(page.getByText(NAMED_AREA.name, { exact: true })).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("settings modal filters displayed and searched access-point area types", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");

  const settingsButton = page.getByRole("button", { name: "Settings" });
  await settingsButton.click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("checkbox", { name: /Rural/ }).uncheck();
  await page.getByRole("checkbox", { name: /Populated/ }).uncheck();
  await page.getByRole("checkbox", { name: /Unknown/ }).uncheck();
  await expect(page.getByRole("checkbox", { name: /Remote/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(settingsButton).toBeFocused();

  await enterDrawnArea(page);
  await expect.poll(() => harness.previewRequests.at(-1)?.accessPointRemoteness).toEqual(["remote"]);
  const accessPointSelect = page.getByRole("combobox", { name: "Access point", exact: true });
  await expect(accessPointSelect.locator("option")).toHaveCount(2);
  await expect(accessPointSelect.locator("option").last()).toHaveText("Stevens Creek Trailhead");

  await generate(page);
  expect(harness.generationRequests.at(-1)).toMatchObject({
    accessPointRemoteness: ["remote"],
  });
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("typed ArcGIS origin and keyboard refinement produce a drive-plus-region filter", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");
  await chooseMode(page, "Drive time");

  await expect(page.getByLabel("Typical drive time")).toHaveValue("30");
  await selectTypedOrigin(page);
  await calculateDriveArea(page);
  await selectNamedRegionWithKeyboard(page, "Named-region refinement");
  await expect.poll(() => harness.previewRequests.at(-1)?.accessFilter).toMatchObject({
    mode: "drive-time",
    reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc",
    regionId: NAMED_AREA.id,
  });

  await generate(page);
  expect(harness.generationRequests.at(-1)).toMatchObject({
    version: 3,
    routeFamily: "closed",
    accessFilter: {
      mode: "drive-time",
      reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc",
      regionId: NAMED_AREA.id,
    },
  });
  await page.getByText("Search diagnostics").click();
  await expect(page.getByText(/refined to Monte Bello Open Space Preserve/)).toBeVisible();
  await expect(page.getByText(/Typical drive-time polygons by Esri/)).toBeVisible();
  await page.getByText("Map key", { exact: true }).click();
  await expect(page.getByText("Named refinement", { exact: true })).toBeVisible();
  await expect(page.locator(".key-refinement")).toHaveCSS("border-top-style", "double");
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("coordinate and current-location origins are explicit user actions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) {
          success({ coords: {
            latitude: 37.166,
            longitude: -122.166,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          }, timestamp: Date.now() } as GeolocationPosition);
        },
      },
    });
  });
  const harness = await installOfflineHarness(page);
  await page.goto("/");
  await chooseMode(page, "Drive time");

  await page.getByLabel("Driving origin", { exact: true }).fill("37.1600, -122.1600");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await expect(page.locator(".selection-chip strong")).toHaveText("37.16000, -122.16000");
  expect(harness.calls.filter((call) => call.pathname.startsWith("/api/geocoding"))).toEqual([]);

  await page.getByRole("button", { name: "Use my current location" }).click();
  await expect(page.getByText("Current location", { exact: true })).toBeVisible();
  await calculateDriveArea(page);
  const reachabilityCall = harness.calls.find((call) => call.pathname === "/api/reachability");
  expect(reachabilityCall?.body).toMatchObject({
    origin: { lat: 37.166, lon: -122.166, label: "Current location" },
  });
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("location denial is announced and leaves typed and coordinate fallbacks available", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(_success: PositionCallback, error?: PositionErrorCallback) {
          error?.({ code: 1, message: "Denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        },
      },
    });
  });
  const harness = await installOfflineHarness(page);
  await page.goto("/");
  await chooseMode(page, "Drive time");
  await page.getByRole("button", { name: "Use my current location" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "Location permission was denied" })).toContainText(
    "Location permission was denied. Type an origin or coordinates instead.",
  );
  await expect(page.getByLabel("Driving origin", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Use coordinates" })).toBeEnabled();
  expect(harness.calls.filter((call) => call.pathname === "/api/reachability")).toHaveLength(0);
});

test("mode switching aborts stale drive-time and route-generation responses", async ({ page }) => {
  const harness = await installOfflineHarness(page, {
    deferReachability: true,
    deferGeneration: true,
  });
  await page.goto("/");

  await chooseMode(page, "Drive time");
  await page.getByLabel("Driving origin", { exact: true }).fill("37.1600, -122.1600");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await page.getByRole("button", { name: "Calculate drive-time area" }).click();
  await expect(page.getByRole("button", { name: "Calculating…" })).toBeDisabled();
  await chooseMode(page, "Draw area");
  harness.releaseReachability();
  await chooseMode(page, "Drive time");
  await expect(page.getByRole("status").filter({ hasText: "Drive-time area ready" })).toHaveCount(0);

  harness.releaseReachability();
  await page.getByRole("button", { name: "Calculate drive-time area" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Drive-time area ready" })).toBeVisible();
  await page.getByRole("button", { name: "Generate routes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Searching eligible trailheads" }).first()).toBeVisible();
  await chooseMode(page, "Named region");
  harness.releaseGeneration();
  await expect(page.getByRole("heading", { name: "Results", exact: true })).toHaveCount(0);
  expect(harness.blockedExternalRequests).toEqual([]);
});

test("closed routes expose topology while route geometry may leave the trailhead filter", async ({ page }) => {
  const harness = await installOfflineHarness(page);
  await page.goto("/");
  await enterDrawnArea(page);

  await page.getByRole("slider", { name: "Maximum repeated trail" }).fill("20");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Search effort").selectOption("quick");
  await page.getByRole("button", { name: "Done" }).click();
  await generate(page);

  expect(harness.generationRequests.at(-1)).toMatchObject({
    version: 3,
    routeFamily: "closed",
    closedRoute: { maximumRepeatedTrailPct: 20 },
    searchEffort: "quick",
  });
  await page.getByText("Route details", { exact: true }).click();
  await expect(page.getByText("Repeated trail", { exact: true })).toBeVisible();
  await expect(page.getByText("Simple loop · 1 cycle · 0% repeated", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Near misses" })).toHaveCount(0);

  const request = harness.generationRequests.at(-1) as GenerateClosedRoutesRequestV3;
  const fixtureRoute = routeResponse(request).exact[0]!;
  expect(fixtureRoute.geometry.coordinates.some((position) => !pointInsideArea(position, FILTER_GEOMETRY))).toBe(true);
  expect(fixtureRoute.geometry.coordinates.every((position) => pointInsideArea(position, PACK_COVERAGE))).toBe(true);
  await page.getByText("Map key", { exact: true }).click();
  const mapKey = page.getByLabel("Map symbol explanations");
  await expect(mapKey.getByText("Trailhead filter", { exact: true })).toBeVisible();
  await expect(mapKey.getByText("Suggested route", { exact: true })).toBeVisible();
  await expect(mapKey.getByText("Route start", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "Highlighted areas filter trailheads, not route geometry. Routes remain inside installed coverage.",
    { exact: true },
  )).toBeVisible();
});

test("mobile panels scroll internally and map symbols remain distinguishable without color", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await installOfflineHarness(page, { routeCount: 10 });
  await page.goto("/");
  await enterDrawnArea(page);

  const builder = page.locator(".builder-panel");
  await expect.poll(() => builder.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await builder.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await builder.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await generate(page);
  const results = page.locator(".results-panel");
  await expect(results).toBeVisible();
  await expect.poll(() => results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await results.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await results.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByText("Map key", { exact: true }).click();
  const symbols = await page.evaluate(() => {
    const signature = (selector: string) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return [
        style.width,
        style.height,
        style.borderTopStyle,
        style.borderRadius,
        style.transform,
      ].join("|");
    };
    return {
      coverage: signature(".key-coverage"),
      filter: signature(".key-filter"),
      trail: signature(".key-trail"),
      route: signature(".key-route"),
    };
  });
  expect(new Set(Object.values(symbols)).size).toBe(Object.keys(symbols).length);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByRole("radiogroup", { name: "Trailhead filter mode" })).toBeVisible();
  await expect(page.getByLabel("Map status")).toBeVisible();
  await expect(page.getByLabel("Map symbol explanations")).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});
