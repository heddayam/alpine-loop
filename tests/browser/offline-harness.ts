import { expect, type Page, type Route } from "@playwright/test";
import type { AppSettingsV1, CreateBatchRouteJobV1, GenerateClosedRoutesRequestV3 } from "../../lib/contracts";
import { ACCESS_POINTS, FILTER_GEOMETRY, NAMED_AREA, NAMED_AREA_SUMMARY, REACHABILITY_ID, TRAIL_NETWORK, routeResponse } from "./fixtures";

const TRANSPARENT_TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
export const JOB_ID = "db52ceda-c6ef-47f1-9153-dba294a9eccc";
export const SEARCH_REGION = { ...NAMED_AREA_SUMMARY, displayOrder: 0 };

export type RecordedCall = { method: string; pathname: string; body?: unknown };
export type OfflineHarness = {
  calls: RecordedCall[];
  generationRequests: GenerateClosedRoutesRequestV3[];
  reachabilityRequests: unknown[];
  batchRequests: CreateBatchRouteJobV1[];
  settingsRequests: AppSettingsV1[];
  previewRequests: Array<Pick<GenerateClosedRoutesRequestV3, "accessFilter" | "includeUncertainAccess" | "accessPointRemoteness">>;
  releaseGeneration(): void;
  blockedExternalRequests: string[];
};
type HarnessOptions = { routeCount?: number; deferGeneration?: boolean };

async function body(route: Route): Promise<unknown> {
  const text = route.request().postData();
  return text ? JSON.parse(text) as unknown : undefined;
}

function completedJob(request: CreateBatchRouteJobV1) {
  return {
    version: 1, id: JOB_ID, status: "completed", request,
    pack: { id: request.packId, dataVersion: "fixture-v4", builtAt: "2026-08-04T00:00:00Z" },
    searchRegion: { id: SEARCH_REGION.id, name: SEARCH_REGION.name },
    progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2, exactRouteCount: 2, nearMissRouteCount: 0, truncatedAccessPointCount: 0, elapsedMs: 1200 },
    partial: false, stale: false, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:01Z", completedAt: "2026-08-06T00:00:01Z",
  };
}

export async function installOfflineHarness(page: Page, options: HarnessOptions = {}): Promise<OfflineHarness> {
  const calls: RecordedCall[] = [];
  const generationRequests: GenerateClosedRoutesRequestV3[] = [];
  const reachabilityRequests: unknown[] = [];
  const batchRequests: CreateBatchRouteJobV1[] = [];
  const settingsRequests: AppSettingsV1[] = [];
  const previewRequests: OfflineHarness["previewRequests"] = [];
  const blockedExternalRequests: string[] = [];
  let releaseGeneration: () => void = () => undefined;
  const generationMayFinish = options.deferGeneration ? new Promise<void>((resolve) => { releaseGeneration = resolve; }) : Promise.resolve();
  let settings: AppSettingsV1 = {
    schemaVersion: 1,
    includeUncertainAccess: true,
    accessPointRemoteness: ["remote", "unknown"],
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
    if (request.method() === "GET" && url.pathname.endsWith("/search-regions")) { await route.fulfill({ json: { regions: [SEARCH_REGION] } }); return; }
    if (request.method() === "GET" && url.pathname.endsWith(`/named-areas/${NAMED_AREA.id}`)) { await route.fulfill({ json: { region: NAMED_AREA } }); return; }
    if (request.method() === "POST" && url.pathname.endsWith("/access-points/preview")) {
      const preview = requestBody as OfflineHarness["previewRequests"][number];
      previewRequests.push(preview);
      await route.fulfill({ json: { accessPoints: ACCESS_POINTS.filter((point) => preview.accessPointRemoteness.includes(point.remoteness) && (preview.includeUncertainAccess || point.accessState !== "unknown")), filterGeometry: FILTER_GEOMETRY, trailNetwork: TRAIL_NETWORK } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/geocoding/suggest") { await route.fulfill({ json: { suggestions: [{ id: "arcgis-castle-rock", label: "Castle Rock, California", magicKey: "fixture-magic-key" }] } }); return; }
    if (request.method() === "POST" && url.pathname === "/api/geocoding/resolve") { await route.fulfill({ json: { origin: { lon: -122.14, lat: 37.16, label: "Castle Rock, California" } } }); return; }
    if (request.method() === "POST" && url.pathname === "/api/reachability") {
      reachabilityRequests.push(requestBody);
      await route.fulfill({ status: 202, json: { status: "pending", requestId: REACHABILITY_ID, pollAfterMs: 500 } });
      return;
    }
    if (request.method() === "GET" && url.pathname === `/api/reachability/${REACHABILITY_ID}`) {
      await route.fulfill({ json: { status: "complete", requestId: REACHABILITY_ID, provider: "arcgis", durationMinutes: 30, resolvedAt: "2026-08-04T12:00:00.000Z", geometry: FILTER_GEOMETRY } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/routes/generate") {
      const generationRequest = requestBody as GenerateClosedRoutesRequestV3;
      generationRequests.push(generationRequest);
      await generationMayFinish;
      await route.fulfill({ json: routeResponse(generationRequest, options.routeCount ?? 1) }).catch(() => undefined);
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/route-jobs") {
      const batchRequest = requestBody as CreateBatchRouteJobV1;
      batchRequests.push(batchRequest);
      await route.fulfill({ status: 202, json: { job: completedJob(batchRequest) } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/route-jobs") { await route.fulfill({ json: { version: 1, jobs: batchRequests.map(completedJob) } }); return; }
    if (request.method() === "GET" && url.pathname === `/api/route-jobs/${JOB_ID}/results`) {
      const requestFixture = routeResponse({ version: 3, packId: "fixture-pack", accessFilter: { mode: "drawn-area", bbox: FILTER_GEOMETRY.coordinates[0]!.reduce<[number, number, number, number]>((bbox, [lon, lat]) => [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)], [180, 90, -180, -90]) }, routeFamily: "closed", closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true, accessPointRemoteness: ["remote", "rural", "populated", "unknown"], searchEffort: "quick", limit: 10 }, 2);
      await route.fulfill({ json: { version: 1, job: completedJob(batchRequests[0]!), results: requestFixture.exact.map((result) => ({ matchType: "exact", accessPointId: result.startAccessPoint.id, route: result })) } });
      return;
    }
    if ((request.method() === "POST" && url.pathname.endsWith("/cancel")) || request.method() === "DELETE") { await route.fulfill({ json: { ok: true } }); return; }
    await route.fulfill({ status: 404, json: { error: { code: "UNEXPECTED_TEST_REQUEST", message: `No offline fixture for ${url.pathname}` } } });
  });

  return { calls, generationRequests, reachabilityRequests, batchRequests, settingsRequests, previewRequests, releaseGeneration, blockedExternalRequests };
}

export async function enterDrawnArea(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Use demo trailhead filter" }).click();
  await expect(page.getByRole("region", { name: "Drawn boundary" }).getByRole("status")).toContainText("-122.1830, 37.1550, -122.1400, 37.1780");
}

export async function selectTypedOrigin(page: Page): Promise<void> {
  const input = page.getByLabel("Driving origin", { exact: true });
  await input.fill("Castle Rock");
  await page.getByRole("option", { name: /Castle Rock, California/ }).click();
  await expect(input).toHaveValue("Castle Rock, California");
}
