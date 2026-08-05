import { expect, type Page, type Route } from "@playwright/test";
import type { GenerateRoutesRequestV2 } from "../../lib/contracts";
import {
  ACCESS_POINTS,
  FILTER_GEOMETRY,
  NAMED_AREA,
  NAMED_AREA_SUMMARY,
  REACHABILITY_ID,
  REFINEMENT_GEOMETRY,
  TRAIL_NETWORK,
  routeResponse,
} from "./fixtures";

const TRANSPARENT_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export type RecordedCall = {
  method: string;
  pathname: string;
  body?: unknown;
};

export type OfflineHarness = {
  calls: RecordedCall[];
  generationRequests: GenerateRoutesRequestV2[];
  previewRequests: Array<{ accessFilter: GenerateRoutesRequestV2["accessFilter"] }>;
  releaseReachability(): void;
  releaseGeneration(): void;
  blockedExternalRequests: string[];
};

type HarnessOptions = {
  routeCount?: number;
  deferReachability?: boolean;
  deferGeneration?: boolean;
};

async function body(route: Route): Promise<unknown> {
  const text = route.request().postData();
  return text ? JSON.parse(text) as unknown : undefined;
}

export async function installOfflineHarness(
  page: Page,
  options: HarnessOptions = {},
): Promise<OfflineHarness> {
  const calls: RecordedCall[] = [];
  const generationRequests: GenerateRoutesRequestV2[] = [];
  const previewRequests: Array<{ accessFilter: GenerateRoutesRequestV2["accessFilter"] }> = [];
  const blockedExternalRequests: string[] = [];
  let releaseReachability: () => void = () => undefined;
  const reachabilityMayFinish = options.deferReachability
    ? new Promise<void>((resolve) => { releaseReachability = resolve; })
    : Promise.resolve();
  let releaseGeneration: () => void = () => undefined;
  const generationMayFinish = options.deferGeneration
    ? new Promise<void>((resolve) => { releaseGeneration = resolve; })
    : Promise.resolve();

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "basemap.nationalmap.gov") {
      await route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_TILE });
      return;
    }
    if (url.origin !== "http://127.0.0.1:3101") {
      blockedExternalRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    const requestBody = await body(route);
    calls.push({ method: request.method(), pathname: url.pathname, body: requestBody });

    if (request.method() === "GET" && /\/named-areas$/.test(url.pathname)) {
      await route.fulfill({ json: { regions: [NAMED_AREA_SUMMARY] } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith(`/named-areas/${NAMED_AREA.id}`)) {
      await route.fulfill({ json: { region: NAMED_AREA } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/access-points/preview")) {
      const preview = requestBody as { accessFilter: GenerateRoutesRequestV2["accessFilter"] };
      previewRequests.push(preview);
      await route.fulfill({ json: {
        accessPoints: ACCESS_POINTS,
        filterGeometry: FILTER_GEOMETRY,
        ...(preview.accessFilter.mode === "drive-time" && preview.accessFilter.regionId
          ? { refinementGeometry: REFINEMENT_GEOMETRY }
          : {}),
        trailNetwork: TRAIL_NETWORK,
      } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/geocoding/suggest") {
      await route.fulfill({ json: {
        suggestions: [{
          id: "arcgis-castle-rock",
          label: "Castle Rock, California",
          magicKey: "fixture-magic-key",
        }],
        attribution: { provider: "arcgis", label: "Esri", url: "https://www.esri.com/" },
      } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/geocoding/resolve") {
      await route.fulfill({ json: {
        origin: { lon: -122.14, lat: 37.16, label: "Castle Rock, California" },
        attribution: { provider: "arcgis", label: "Esri", url: "https://www.esri.com/" },
      } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/reachability") {
      await reachabilityMayFinish;
      await route.fulfill({ json: {
        status: "complete",
        requestId: REACHABILITY_ID,
        provider: "arcgis",
        durationMinutes: 30,
        resolvedAt: "2026-08-04T12:00:00Z",
        geometry: FILTER_GEOMETRY,
      } }).catch(() => undefined);
      return;
    }
    if (request.method() === "GET" && url.pathname === `/api/reachability/${REACHABILITY_ID}`) {
      await route.fulfill({ json: {
        status: "complete",
        requestId: REACHABILITY_ID,
        provider: "arcgis",
        durationMinutes: 30,
        resolvedAt: "2026-08-04T12:00:00Z",
        geometry: FILTER_GEOMETRY,
      } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/routes/generate") {
      const generationRequest = requestBody as GenerateRoutesRequestV2;
      generationRequests.push(generationRequest);
      await generationMayFinish;
      await route.fulfill({ json: routeResponse(generationRequest, options.routeCount ?? 1) })
        .catch(() => undefined);
      return;
    }
    await route.fulfill({ status: 404, json: {
      error: { code: "UNEXPECTED_TEST_REQUEST", message: `No offline fixture for ${url.pathname}` },
    } });
  });

  return {
    calls,
    generationRequests,
    previewRequests,
    releaseReachability,
    releaseGeneration,
    blockedExternalRequests,
  };
}

export async function enterDrawnArea(page: Page): Promise<void> {
  await page.getByLabel("West longitude").fill("-122.1800");
  await page.getByLabel("South latitude").fill("37.1550");
  await page.getByLabel("East longitude").fill("-122.1550");
  await page.getByLabel("North latitude").fill("37.1700");
  await expect(page.getByRole("combobox", { name: "Access point", exact: true })).toBeVisible();
}

export async function selectNamedRegionWithKeyboard(page: Page, label = "Installed named region") {
  const input = page.getByLabel(label, { exact: true });
  await input.fill("Monte Bello");
  const option = page.getByRole("option", { name: /Monte Bello Open Space Preserve/ });
  await expect(option).toBeVisible();
  await input.press("Tab");
  await expect(option).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Monte Bello Open Space Preserve", { exact: true })).toBeVisible();
}

export async function selectTypedOrigin(page: Page): Promise<void> {
  const input = page.getByLabel("Driving origin", { exact: true });
  await input.fill("Castle Rock");
  await page.getByRole("option", { name: /Castle Rock, California/ }).click();
  await expect(page.getByText("Castle Rock, California", { exact: true })).toBeVisible();
}

export async function calculateDriveArea(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Calculate drive-time area" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Drive-time area ready" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Access point", exact: true })).toBeVisible();
}
