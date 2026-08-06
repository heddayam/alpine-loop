// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder } from "./HikeBuilder";

vi.mock("../map/HikeMap", () => ({
  HikeMap: ({ onBoundsChange, mode, routes = [] }: {
    onBoundsChange: (bounds: [number, number, number, number] | null) => void;
    mode: string;
    routes?: Array<{ id: string }>;
  }) => <div aria-label="Mock map"><output aria-label="Mock map mode">{mode}</output><button type="button" onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture area</button><button type="button" onClick={() => onBoundsChange([-122.17, 37.15, -122.13, 37.18])}>Change fixture area</button><output aria-label="Map routes">{routes.map(({ id }) => id).join(",")}</output></div>,
}));

const accessPoint = { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, kind: "trailhead", accessState: "public", confidence: "high", remoteness: "remote" };
const preview = { filterGeometry: { type: "Polygon", coordinates: [[[-122.18, 37.15], [-122.13, 37.15], [-122.13, 37.18], [-122.18, 37.18], [-122.18, 37.15]]] }, accessPoints: [accessPoint] };
const generatedRoute = {
  id: "exact-route", geometry: { type: "LineString", coordinates: [[-122.16, 37.16], [-122.12, 37.19], [-122.16, 37.16]] },
  startAccessPoint: { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, accessState: "public", confidence: "high" },
  distanceMeters: 6400, elevationGainMeters: 300, elevationLossMeters: 300, minimumElevationMeters: 300, maximumElevationMeters: 600,
  steepestSustainedGradePct: 9, topology: { kind: "simple-loop", cycleCount: 1, cycleBlockCount: 1, repeatedTrailDistanceMeters: 0, repeatedTrailFraction: 0, sharedStemDistanceMeters: 0, connectorCount: 0 }, trailNames: ["Fixture Ridge"], warnings: [],
  source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["fixture"] },
};
const routeResponse = {
  version: 3, requestId: "request-1", pack: { id: "fixture-pack", schemaVersion: "3", dataVersion: "fixture-3", builtAt: "2026-08-04T00:00:00Z" },
  requested: 10, resolvedAccessFilter: { mode: "drawn-area", label: "Drawn area" }, exact: [generatedRoute], nearMisses: [],
  diagnostics: { elapsedMs: 1, expandedStates: 1, candidateCount: 1, eligibleAccessPointCount: 1, searchedAccessPointCount: 1, graphQueryCount: 1, maximumLoadedDirectedEdges: 4, exhausted: true, truncationReasons: [], shortfallReasons: [], noCycleAccessPointCount: 0, feasibleAccessPointCount: 1, attachmentGroupCount: 1, probedAttachmentGroupCount: 1, deeplySearchedAttachmentGroupCount: 1, loadedTopologyNetworkCount: 1, cycleBlockCount: 1, cyclePrimitiveCount: 1, composedCandidateCount: 1, repairedCandidateCount: 0, directedValidationRejectionCount: 0, expandedAssemblyStates: 1, timeToFirstExactMs: 1, hardTruncationReasons: [], nonBudgetShortfallReasons: ["fewer-exact-routes-than-requested"] },
};
const searchRegion = { id: "osm-relation-1", name: "Santa Cruz Mountains", kind: "protected-area", context: "California", bbox: [-122.3, 37, -121.8, 37.5], sourceIds: ["osm"], displayOrder: 0 };
const job = {
  version: 1, id: "3d594650-3436-4f8b-a0e8-38d13fc148ca", status: "queued", request: { version: 1, packId: "fixture-pack", origin: { lon: -122.16, lat: 37.16, label: "37.16000, -122.16000" }, durationMinutes: 30, searchRegionId: searchRegion.id, criteria: { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true, accessPointRemoteness: ["remote", "rural", "populated", "unknown"] }, routesPerAccessPoint: 10 }, pack: { id: "fixture-pack", dataVersion: "fixture-4", builtAt: "2026-08-04T00:00:00Z" }, searchRegion: { id: searchRegion.id, name: searchRegion.name }, progress: { eligibleAccessPointCount: 0, processedAccessPointCount: 0, exactRouteCount: 0, nearMissRouteCount: 0, truncatedAccessPointCount: 0, elapsedMs: 0 }, partial: false, stale: false, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z",
};

function mockBaseFetch(onRequest?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const custom = onRequest?.(url, init);
    if (custom) return custom;
    if (url === "/api/route-jobs") return new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 });
    if (url.includes("/access-points/preview")) return new Response(JSON.stringify(preview), { status: 200 });
    if (url === "/api/routes/generate") return new Response(JSON.stringify(routeResponse), { status: 200 });
    if (url.includes("/search-regions")) return new Response(JSON.stringify({ searchRegions: [searchRegion] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

describe("HikeBuilder two-mode route search", () => {
  beforeEach(() => mockBaseFetch());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("offers only Explore and Batch search and removes redundant controls", async () => {
    render(<HikeBuilder />);
    expect(screen.getByRole("radio", { name: /Explore/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Batch search/ })).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Named region/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate routes" })).not.toBeInTheDocument();
    expect(screen.getByText(/search automatically after 600 ms/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(10);
    expect(screen.queryByLabelText("Search effort")).not.toBeInTheDocument();
  });

  it("debounces a valid Explore change and always submits Quick effort", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    expect(screen.queryByRole("button", { name: "Generate routes" })).not.toBeInTheDocument();
    expect(await screen.findByText("1 exact route ready.", {}, { timeout: 2_000 })).toBeVisible();
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/routes/generate");
    const request = JSON.parse(String(generationCall?.[1]?.body));
    expect(request).toMatchObject({ version: 3, searchEffort: "quick", accessFilter: { mode: "drawn-area", bbox: [-122.18, 37.15, -122.13, 37.18] }, limit: 10 });
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("exact-route");
  });

  it("aborts a stale Explore request after a subsequent boundary change", async () => {
    vi.restoreAllMocks();
    let generationSignal: AbortSignal | undefined;
    mockBaseFetch((url, init) => {
      if (url === "/api/routes/generate") { generationSignal = init?.signal ?? undefined; return new Promise<Response>(() => undefined); }
      return undefined;
    });
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await waitFor(() => expect(generationSignal).toBeDefined(), { timeout: 2_000 });
    await userEvent.click(screen.getByRole("button", { name: "Change fixture area" }));
    await waitFor(() => expect(generationSignal?.aborted).toBe(true));
  });

  it("launches Batch with a resolved origin, curated region, and settings snapshot", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/route-jobs" && init?.method === "POST") return new Response(JSON.stringify({ job }), { status: 202 });
      if (url === "/api/route-jobs") return new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 });
      if (url.includes("/search-regions")) return new Response(JSON.stringify({ searchRegions: [searchRegion] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("radio", { name: /Batch search/ }));
    expect(await screen.findByRole("option", { name: "Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Use coordinates" }));
    await userEvent.selectOptions(screen.getByLabelText("Search region"), searchRegion.id);
    await userEvent.click(screen.getByRole("button", { name: "Launch batch search" }));
    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    const launch = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/route-jobs" && init?.method === "POST");
    expect(JSON.parse(String(launch?.[1]?.body))).toMatchObject({ version: 1, packId: "fixture-pack", durationMinutes: 30, searchRegionId: searchRegion.id, routesPerAccessPoint: 10, criteria: { distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true, accessPointRemoteness: ["remote", "rural", "populated", "unknown"] } });
    expect(screen.queryByLabelText("Access point")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Calculate drive-time/ })).not.toBeInTheDocument();
  });

  it("uses location only on request and reports denial", async () => {
    const getCurrentPosition = vi.fn((_success, failure: PositionErrorCallback) => failure({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    render(<HikeBuilder />);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: /Batch search/ }));
    await userEvent.click(screen.getByRole("button", { name: "Use my current location" }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Location permission was denied");
  });
});
