// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder } from "./HikeBuilder";

vi.mock("../map/HikeMap", () => ({
  HikeMap: ({ onBoundsChange, routes = [] }: {
    onBoundsChange: (bounds: [number, number, number, number] | null) => void;
    routes?: Array<{ id: string }>;
  }) => <div aria-label="Mock map"><button type="button" onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture area</button><button type="button" onClick={() => onBoundsChange([-122.17, 37.15, -122.13, 37.18])}>Change fixture area</button><output aria-label="Map routes">{routes.map(({ id }) => id).join(",")}</output></div>,
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
    if (url === "/api/reachability") return new Response(JSON.stringify({ status: "complete", requestId: "3d594650-3436-4f8b-a0e8-38d13fc148ca", provider: "arcgis", durationMinutes: 30, resolvedAt: "2026-08-06T00:00:00Z", geometry: preview.filterGeometry }), { status: 200 });
    if (url.includes("/search-regions")) return new Response(JSON.stringify({ searchRegions: [searchRegion] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("HikeBuilder unified route search", () => {
  beforeEach(() => mockBaseFetch());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("shows one shared builder with both explicit actions", async () => {
    render(<HikeBuilder />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Driving origin")).toBeVisible();
    expect(screen.getByLabelText("Typical drive time")).toHaveValue("30");
    expect(screen.getByLabelText("Broad region")).toBeVisible();
    expect(screen.getByRole("button", { name: "Quick search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Batch search" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Drawn boundary" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(10);
    expect(screen.queryByLabelText("Search effort")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Remote/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Unknown/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Rural/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Populated/ })).not.toBeChecked();
  });

  it("updates drive-time and closed-route controls without retaining synthetic events", async () => {
    render(<HikeBuilder />);
    await userEvent.selectOptions(screen.getByLabelText("Typical drive time"), "45");
    expect(screen.getByLabelText("Typical drive time")).toHaveValue("45");
    fireEvent.change(screen.getByLabelText("Maximum repeated trail"), { target: { value: "20" } });
    expect(screen.getByLabelText("Maximum repeated trail")).toHaveValue("20");
    await userEvent.click(screen.getByRole("switch", { name: /Limit the shared access stem/ }));
    expect(screen.getByLabelText("Maximum shared stem")).toBeVisible();
    await userEvent.clear(screen.getByLabelText("Maximum shared stem"));
    await userEvent.type(screen.getByLabelText("Maximum shared stem"), "2.5");
    expect(screen.getByLabelText("Maximum shared stem")).toHaveValue(2.5);
    await userEvent.click(screen.getByRole("switch", { name: /Allow figure-eights/ }));
    expect(screen.getByRole("switch", { name: /Allow figure-eights/ })).not.toBeChecked();
  });

  it("runs Quick explicitly and uses a drawn boundary as its override", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/routes/generate")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    expect(await screen.findByText("1 exact route ready.")).toBeVisible();
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/routes/generate");
    const request = JSON.parse(String(generationCall?.[1]?.body));
    expect(request).toMatchObject({ version: 3, searchEffort: "quick", accessFilter: { mode: "drawn-area", bbox: [-122.18, 37.15, -122.13, 37.18] }, limit: 10 });
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("exact-route");
  });

  it("resolves drive time before Quick when no boundary is drawn", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    expect(await screen.findByRole("option", { name: "Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Use coordinates" }));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    expect(await screen.findByText("1 exact route ready.")).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reachability")).toBe(true);
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/routes/generate");
    expect(JSON.parse(String(generationCall?.[1]?.body))).toMatchObject({
      searchEffort: "quick",
      accessFilter: { mode: "drive-time", reachabilityId: "3d594650-3436-4f8b-a0e8-38d13fc148ca", regionId: searchRegion.id },
      accessPointRemoteness: ["remote", "unknown"],
    });
  });

  it("aborts a stale Quick request after a subsequent boundary change", async () => {
    vi.restoreAllMocks();
    let generationSignal: AbortSignal | undefined;
    mockBaseFetch((url, init) => {
      if (url === "/api/routes/generate") { generationSignal = init?.signal ?? undefined; return new Promise<Response>(() => undefined); }
      return undefined;
    });
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
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
    expect(await screen.findByRole("option", { name: "Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Use coordinates" }));
    await userEvent.selectOptions(screen.getByLabelText("Broad region"), searchRegion.id);
    await userEvent.click(screen.getByRole("button", { name: "Batch search" }));
    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    const launch = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/route-jobs" && init?.method === "POST");
    expect(JSON.parse(String(launch?.[1]?.body))).toMatchObject({ version: 1, packId: "fixture-pack", durationMinutes: 30, searchRegionId: searchRegion.id, routesPerAccessPoint: 10, criteria: { distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true, accessPointRemoteness: ["remote", "unknown"] } });
    expect(screen.queryByLabelText("Access point")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Calculate drive-time/ })).not.toBeInTheDocument();
  });

  it("serializes background polling and continues while Jobs is closed", async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    const firstJobs = deferred<Response>();
    let listRequests = 0;
    mockBaseFetch((url, init) => {
      if (url === "/api/route-jobs" && !init?.method) {
        listRequests += 1;
        if (listRequests === 1) return firstJobs.promise;
        return new Response(JSON.stringify({ version: 1, jobs: [{ ...job, status: "completed", completedAt: "2026-08-06T00:00:05Z" }] }), { status: 200 });
      }
      return undefined;
    });
    render(<HikeBuilder />);
    await act(async () => undefined);
    expect(listRequests).toBe(1);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(listRequests).toBe(1);

    firstJobs.resolve(new Response(JSON.stringify({ version: 1, jobs: [job] }), { status: 200 }));
    await act(async () => { await firstJobs.promise; });
    expect(screen.getByRole("button", { name: "Jobs (1)" })).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await act(async () => undefined);
    expect(listRequests).toBe(2);
    expect(screen.getByRole("button", { name: "Jobs" })).toBeVisible();
    expect(screen.getByText(/Santa Cruz Mountains batch search complete/)).toBeInTheDocument();
  });

  it("keeps the current controller when simultaneous forced refreshes replace a stale request", async () => {
    vi.restoreAllMocks();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    let listRequests = 0;
    mockBaseFetch((url, init) => {
      if (url !== "/api/route-jobs" || init?.method) return undefined;
      listRequests += 1;
      if (init?.signal) signals.push(init.signal);
      if (listRequests === 1) return first.promise;
      if (listRequests === 2) return second.promise;
      return new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 });
    });
    render(<HikeBuilder />);
    await waitFor(() => expect(listRequests).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(signals[0]?.aborted).toBe(true);
    first.resolve(new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 }));
    await waitFor(() => expect(listRequests).toBe(2));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(signals[1]?.aborted).toBe(true));
    second.resolve(new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 }));
    await waitFor(() => expect(listRequests).toBe(3));
  });

  it("guards rapid duplicate Batch launches and exposes its loading state", async () => {
    vi.restoreAllMocks();
    const launchResponse = deferred<Response>();
    let launches = 0;
    mockBaseFetch((url, init) => {
      if (url === "/api/route-jobs" && init?.method === "POST") { launches += 1; return launchResponse.promise; }
      return undefined;
    });
    render(<HikeBuilder />);
    expect(await screen.findByRole("option", { name: "Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Use coordinates" }));
    const launch = screen.getByRole("button", { name: "Batch search" });
    fireEvent.click(launch);
    fireEvent.click(launch);
    expect(launches).toBe(1);
    expect(screen.getByRole("button", { name: "Starting batch…" })).toBeDisabled();

    launchResponse.resolve(new Response(JSON.stringify({ job }), { status: 202 }));
    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Batch search" })).toBeEnabled();
  });

  it("uses location only on request and reports denial", async () => {
    const getCurrentPosition = vi.fn((_success, failure: PositionErrorCallback) => failure({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    render(<HikeBuilder />);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use my current location" }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Location permission was denied");
  });
});
