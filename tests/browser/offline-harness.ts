import { expect, type Page, type Route } from "@playwright/test";
import type { AppSettingsV1 } from "../../lib/contracts";
import type { SearchIntent, SearchRequest, RouteJobV2 } from "../../lib/contracts/search";
import { ACCESS_POINTS, PACK_COVERAGE, NAMED_AREA_SUMMARY, TRAIL_NETWORK, routeResponse } from "./fixtures";

const TRANSPARENT_TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
export const JOB_ID = "db52ceda-c6ef-47f1-9153-dba294a9eccc";
export const SEARCH_REGION = { ...NAMED_AREA_SUMMARY, displayOrder: 0 };

export type RecordedCall = { method: string; pathname: string; body?: unknown };
export type OfflineHarness = {
  calls: RecordedCall[];
  generationRequests: SearchRequest[];
  batchRequests: SearchIntent[];
  settingsRequests: AppSettingsV1[];
  releaseGeneration(): void;
  blockedExternalRequests: string[];
};
type HarnessOptions = { routeCount?: number; deferGeneration?: boolean };

async function body(route: Route): Promise<unknown> {
  const text = route.request().postData();
  return text ? JSON.parse(text) as unknown : undefined;
}

function completedJob(request: SearchIntent): RouteJobV2 {
  return {
    version: 2, id: JOB_ID, status: "completed", request,
    area: routeResponse({ ...request, limit: 10 }).area,
    progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2, exactRouteCount: 2, nearMissRouteCount: 0, truncatedAccessPointCount: 0, elapsedMs: 1200 },
    partial: false, stale: false, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:01Z", completedAt: "2026-08-06T00:00:01Z",
  };
}

export async function installOfflineHarness(page: Page, options: HarnessOptions = {}): Promise<OfflineHarness> {
  const calls: RecordedCall[] = [];
  const generationRequests: SearchRequest[] = [];
  const batchRequests: SearchIntent[] = [];
  const settingsRequests: AppSettingsV1[] = [];
  const blockedExternalRequests: string[] = [];
  let releaseGeneration: () => void = () => undefined;
  const generationMayFinish = options.deferGeneration ? new Promise<void>((resolve) => { releaseGeneration = resolve; }) : Promise.resolve();
  let settings: AppSettingsV1 = {
    schemaVersion: 1,
    includeUncertainAccess: true,
    showRegionBoundaries: false,
    quickSearchRouteCount: 10,
    gradeConstraintEnabled: false,
    selectedGradePreset: "moderate",
    loopOptions: { maximumRepeatedTrailPct: 35, sharedApproachEnabled: false, maximumSharedApproachMiles: 2, allowMultiCycle: true },
    gradePresets: {
      gentle: { maximumClimbP90Pct: 8, maximumSteepClimbingSharePct: 5, maximumSteepRunMiles: 0.1, maximumDescentP90Pct: 10 },
      moderate: { maximumClimbP90Pct: 12, maximumSteepClimbingSharePct: 20, maximumSteepRunMiles: 0.5, maximumDescentP90Pct: 15 },
      steep: { maximumClimbP90Pct: 18, maximumSteepClimbingSharePct: 50, maximumSteepRunMiles: 1.5, maximumDescentP90Pct: 22 },
    },
  };

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "basemap.nationalmap.gov") { await route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_TILE }); return; }
    if (url.origin !== "http://127.0.0.1:3101") { blockedExternalRequests.push(request.url()); await route.abort("blockedbyclient"); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const requestBody = await body(route);
    calls.push({ method: request.method(), pathname: url.pathname, body: requestBody });

    if (request.method() === "GET" && url.pathname === "/api/settings") { await route.fulfill({ json: settings }); return; }
    if (request.method() === "PUT" && url.pathname === "/api/settings") {
      settings = structuredClone(requestBody as AppSettingsV1);
      settingsRequests.push(settings);
      await route.fulfill({ json: settings });
      return;
    }
    if (url.pathname === "/api/search/catalog") { await route.fulfill({ json: { regions: [{ id: SEARCH_REGION.id, name: SEARCH_REGION.name }], coverages: [PACK_COVERAGE], display: { center: [-122.16, 37.165], zoom: 12 } } }); return; }
    if (url.pathname === "/api/map") { await route.fulfill({ json: { accessPoints: ACCESS_POINTS, trailNetwork: TRAIL_NETWORK } }); return; }
    if (request.method() === "POST" && url.pathname === "/api/geocoding/suggest") { await route.fulfill({ json: { suggestions: [{ id: "arcgis-castle-rock", label: "Castle Rock, California", magicKey: "fixture-magic-key" }] } }); return; }
    if (request.method() === "POST" && url.pathname === "/api/geocoding/resolve") { await route.fulfill({ json: { origin: { lon: -122.14, lat: 37.16, label: "Castle Rock, California" } } }); return; }
    if (request.method() === "POST" && url.pathname === "/api/search") {
      const generationRequest = requestBody as SearchRequest;
      generationRequests.push(generationRequest);
      await generationMayFinish;
      await route.fulfill({ json: routeResponse(generationRequest, options.routeCount ?? 1) }).catch(() => undefined);
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/route-jobs") {
      const batchRequest = requestBody as SearchIntent;
      batchRequests.push(batchRequest);
      await route.fulfill({ status: 202, json: completedJob(batchRequest) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/route-jobs") { await route.fulfill({ json: { version: 2, jobs: batchRequests.map(completedJob) } }); return; }
    if (request.method() === "GET" && url.pathname === `/api/route-jobs/${JOB_ID}/results`) {
      const requestFixture = routeResponse({ ...batchRequests[0]!, limit: 10 }, 2);
      await route.fulfill({ json: { version: 2, job: completedJob(batchRequests[0]!), results: requestFixture.exact.map((result) => ({ matchType: "exact", accessPointId: result.startAccessPoint.id, route: result })) } });
      return;
    }
    if ((request.method() === "POST" && url.pathname.endsWith("/cancel")) || request.method() === "DELETE") { await route.fulfill({ json: { ok: true } }); return; }
    await route.fulfill({ status: 404, json: { error: { code: "UNEXPECTED_TEST_REQUEST", message: `No offline fixture for ${url.pathname}` } } });
  });

  return { calls, generationRequests, batchRequests, settingsRequests, releaseGeneration, blockedExternalRequests };
}

export async function enterDrawnArea(page: Page): Promise<number[]> {
  const mobile = (page.viewportSize()?.width ?? 1280) <= 760;
  if (mobile) await page.getByRole("button", { name: "Show map", exact: true }).click();
  const draw = page.getByRole("button", { name: /^(Draw|Redraw) trailhead filter$/ });
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByRole("region", { name: "Hike search map" })).toHaveAttribute("aria-busy", "false");
  await draw.click();
  const canvas = await page.locator(".maplibregl-canvas").boundingBox();
  if (!canvas) throw new Error("Map canvas is unavailable");
  await page.mouse.move(canvas.x + canvas.width * 0.35, canvas.y + canvas.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.7, { steps: 5 });
  await page.mouse.up();
  if (mobile) await page.getByRole("button", { name: "Show panel", exact: true }).click();
  const output = page.getByRole("region", { name: "Drawn boundary" }).locator("output");
  await expect(output).not.toContainText("None");
  const bounds = (await output.getAttribute("data-bounds"))!.split(",").map(Number);
  expect(bounds).toHaveLength(4);
  expect(bounds.every(Number.isFinite)).toBe(true);
  expect(bounds[0]).toBeLessThan(bounds[2]!);
  expect(bounds[1]).toBeLessThan(bounds[3]!);
  return bounds;
}

export async function selectRegion(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Regions: Choose regions" }).click();
  await page.getByRole("checkbox", { name: SEARCH_REGION.name }).check();
  await page.keyboard.press("Escape");
}

export async function selectTypedOrigin(page: Page): Promise<void> {
  const input = page.getByLabel("Driving origin", { exact: true });
  await input.fill("Castle Rock");
  await page.getByRole("option", { name: /Castle Rock, California/ }).click();
  await expect(input).toHaveValue("Castle Rock, California");
}
