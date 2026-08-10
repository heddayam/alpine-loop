// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder, waitForPoll } from "./HikeBuilder";
import { FIXTURE_BUILDER_PACK } from "@/lib/packs/fixture-pack";
import { packCatalogResponseV1Schema } from "@/lib/contracts";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("../map/HikeMap", () => ({
  HikeMap: ({ onBoundsChange, routes = [], accessPoints = [] }: {
    onBoundsChange: (bounds: [number, number, number, number] | null) => void;
    routes?: Array<{ id: string }>;
    accessPoints?: Array<{ id: string }>;
  }) => <div aria-label="Mock map"><button type="button" onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture area</button><button type="button" onClick={() => onBoundsChange([-122.17, 37.15, -122.13, 37.18])}>Change fixture area</button><output aria-label="Map routes">{routes.map(({ id }) => id).join(",")}</output><output aria-label="Map access points">{accessPoints.map(({ id }) => id).join(",")}</output></div>,
}));

const accessPoint = { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, kind: "trailhead", accessState: "public", confidence: "high" };
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
const appSettings = {
  schemaVersion: 1, includeUncertainAccess: true, showRegionBoundaries: false, quickSearchRouteCount: 10,
  gradeConstraintEnabled: false, selectedGradePreset: "moderate",
  loopOptions: { maximumRepeatedTrailPct: 35, sharedApproachEnabled: false, maximumSharedApproachMiles: 2, allowMultiCycle: true },
  gradePresets: {
    gentle: { maximumClimbP90Pct: 8, maximumSteepClimbingSharePct: 5, maximumSteepRunMiles: 0.1, maximumDescentP90Pct: 10 },
    moderate: { maximumClimbP90Pct: 12, maximumSteepClimbingSharePct: 20, maximumSteepRunMiles: 0.5, maximumDescentP90Pct: 15 },
    steep: { maximumClimbP90Pct: 18, maximumSteepClimbingSharePct: 50, maximumSteepRunMiles: 1.5, maximumDescentP90Pct: 22 },
  },
};
const job = {
  version: 1, id: "3d594650-3436-4f8b-a0e8-38d13fc148ca", status: "queued", request: { version: 1, packId: "fixture-pack", origin: { lon: -122.16, lat: 37.16, label: "37.16000, -122.16000" }, durationMinutes: 30, searchRegionId: searchRegion.id, criteria: { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true }, routesPerAccessPoint: 10 }, pack: { id: "fixture-pack", dataVersion: "fixture-4", builtAt: "2026-08-04T00:00:00Z" }, searchRegion: { id: searchRegion.id, name: searchRegion.name }, progress: { eligibleAccessPointCount: 0, processedAccessPointCount: 0, exactRouteCount: 0, nearMissRouteCount: 0, truncatedAccessPointCount: 0, elapsedMs: 0 }, partial: false, stale: false, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z",
};
const regionWideJobRequest = {
  version: job.request.version,
  packId: job.request.packId,
  searchRegionId: job.request.searchRegionId,
  criteria: job.request.criteria,
  routesPerAccessPoint: job.request.routesPerAccessPoint,
};
const catalogRegions = packCatalogResponseV1Schema.parse({ version: 1, regions: [
  {
    id: "santa-cruz-mountains", label: "Santa Cruz Mountains", displayOrder: 1, state: "available", packId: "fixture-pack",
    pack: { id: "fixture-pack", name: "Fixture pack", dataVersion: "fixture-v1", builtAt: "2026-08-04T00:00:00Z", coverageBbox: FIXTURE_BUILDER_PACK.coverageBbox, coverage: FIXTURE_BUILDER_PACK.coverage, display: FIXTURE_BUILDER_PACK.display },
  },
  {
    id: "southern-east-bay", label: "Southern East Bay", displayOrder: 2, state: "available", packId: "southern-east-bay",
    pack: { id: "southern-east-bay", name: "Southern East Bay", dataVersion: "east-bay-v1", builtAt: "2026-08-05T00:00:00Z", coverageBbox: FIXTURE_BUILDER_PACK.coverageBbox, coverage: FIXTURE_BUILDER_PACK.coverage, display: FIXTURE_BUILDER_PACK.display },
  },
  { id: "monterey-carmel", label: "Monterey–Carmel", displayOrder: 3, state: "planned" },
  { id: "henry-coe", label: "Henry Coe", displayOrder: 4, state: "unavailable", packId: "henry-coe" },
] }).regions;

function mockBaseFetch(onRequest?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const custom = onRequest?.(url, init);
    if (custom) return custom;
    if (url === "/api/settings") return new Response(JSON.stringify(appSettings), { status: 200 });
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
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); router.push.mockReset(); router.replace.mockReset(); });

  it("shows every catalog region and only enables installed packs", async () => {
    render(<HikeBuilder regions={catalogRegions} />);
    const selected = screen.getByRole("button", { name: /Santa Cruz Mountains.*Available; selected/ });
    const available = screen.getByRole("button", { name: /Southern East Bay.*Available/ });
    const planned = screen.getByRole("button", { name: /Monterey–Carmel.*Planned; pack not yet available/ });
    const unavailable = screen.getByRole("button", { name: /Henry Coe.*Pack unavailable on this device/ });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).toBeEnabled();
    expect(selected).toHaveClass("region-pill-selected");
    expect(available).toHaveAttribute("aria-pressed", "false");
    expect(planned).toBeDisabled();
    expect(unavailable).toBeDisabled();
    expect(planned.querySelector(".status-dot")).toBeNull();
    expect(unavailable.querySelector(".status-dot")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Region packs" })).toBeVisible();

    await userEvent.click(selected);
    await waitFor(() => expect(selected).toHaveAttribute("aria-pressed", "false"));
    expect(router.replace).toHaveBeenCalledWith("/?packs=none");
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one region pack.");

    await userEvent.click(available);
    await waitFor(() => expect(available).toHaveAttribute("aria-pressed", "true"));
    expect(available).toHaveClass("region-pill-selected");
    expect(router.replace).toHaveBeenLastCalledWith("/?packs=southern-east-bay");
  });

  it("keeps successful pack access points when another selected pack request fails", async () => {
    vi.restoreAllMocks();
    mockBaseFetch((url) => {
      if (url.startsWith("/api/packs/fixture-pack/access-points?")) {
        return new Response(JSON.stringify({ accessPoints: [accessPoint] }), { status: 200 });
      }
      if (url.startsWith("/api/packs/southern-east-bay/access-points?")) {
        return Promise.reject(new TypeError("offline"));
      }
      return undefined;
    });

    render(<HikeBuilder regions={catalogRegions} />);
    await userEvent.click(screen.getByRole("button", { name: /Southern East Bay.*Available/ }));

    await waitFor(() => expect(screen.getByLabelText("Map access points")).toHaveTextContent("fixture-pack::trailhead-a"));
  });

  it("adds a saved job's pack and restores cross-pack results without losing the workspace", async () => {
    vi.restoreAllMocks();
    const otherJob = {
      ...job,
      status: "completed" as const,
      request: { ...job.request, packId: "southern-east-bay" },
      pack: { ...job.pack, id: "southern-east-bay" },
      progress: { ...job.progress, eligibleAccessPointCount: 1, processedAccessPointCount: 1, exactRouteCount: 1 },
      completedAt: "2026-08-06T00:00:05Z",
    };
    mockBaseFetch((url, init) => {
      if (url === "/api/route-jobs" && !init?.method) return new Response(JSON.stringify({ version: 1, jobs: [otherJob] }), { status: 200 });
      if (url === `/api/route-jobs/${otherJob.id}/results?limit=50`) return new Response(JSON.stringify({
        version: 1,
        job: otherJob,
        results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }],
      }), { status: 200 });
      return undefined;
    });

    const view = render(<HikeBuilder regions={catalogRegions} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Jobs" })).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Jobs" }));
    await userEvent.click(await screen.findByRole("button", { name: `View results for ${searchRegion.name}` }));
    expect(await screen.findByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("exact-route");
    expect(screen.getByRole("button", { name: /Southern East Bay.*Available; selected/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Santa Cruz Mountains.*Available/ })).toHaveAttribute("aria-pressed", "false");
    expect(router.replace).toHaveBeenCalledWith("/?packs=southern-east-bay");
    expect(screen.getByRole("button", { name: `Regions: ${searchRegion.name}` })).toBeVisible();

    // The URL update changes the server-provided primary pack. The builder must
    // preserve the job results when those props stream back into the client.
    const nextPack = { ...FIXTURE_BUILDER_PACK, id: "southern-east-bay", name: "Southern East Bay" };
    view.rerender(<HikeBuilder pack={nextPack} regions={catalogRegions} initialSelectedPackIds={["southern-east-bay"]} />);
    expect(screen.getByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("exact-route");
    expect(screen.getByRole("button", { name: `Regions: ${searchRegion.name}` })).toBeVisible();
  });

  it("restores a linked job after pack navigation and removes the one-time URL state", async () => {
    vi.restoreAllMocks();
    const completed = {
      ...job,
      status: "completed" as const,
      progress: { ...job.progress, eligibleAccessPointCount: 1, processedAccessPointCount: 1, exactRouteCount: 1 },
      completedAt: "2026-08-06T00:00:05Z",
    };
    mockBaseFetch((url) => {
      if (url === `/api/route-jobs/${completed.id}/results?limit=50`) return new Response(JSON.stringify({
        version: 1,
        job: completed,
        results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }],
      }), { status: 200 });
      return undefined;
    });

    render(<HikeBuilder restoreJobId={completed.id} />);
    expect(await screen.findByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("exact-route");
    expect(router.replace).toHaveBeenCalledWith("/?packs=fixture-pack");
  });

  it("restores region-wide job results as a named-region search", async () => {
    vi.restoreAllMocks();
    const completed = {
      ...job,
      status: "completed" as const,
      request: regionWideJobRequest,
      progress: { ...job.progress, eligibleAccessPointCount: 1, processedAccessPointCount: 1, exactRouteCount: 1 },
      completedAt: "2026-08-06T00:00:05Z",
    };
    mockBaseFetch((url) => {
      if (url === `/api/route-jobs/${completed.id}/results?limit=50`) return new Response(JSON.stringify({
        version: 1,
        job: completed,
        results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }],
      }), { status: 200 });
      return undefined;
    });

    render(<HikeBuilder restoreJobId={completed.id} />);

    expect(await screen.findByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByText(searchRegion.name, { selector: ".diagnostics p" })).toBeInTheDocument();
    expect(screen.getByText(searchRegion.name, { selector: ".route-region-label" })).toBeVisible();
    expect(screen.queryByText(`${searchRegion.name} · ${searchRegion.name}`)).not.toBeInTheDocument();
    expect(screen.queryByText(`30 minutes · ${searchRegion.name}`)).not.toBeInTheDocument();
  });

  it("restores a linked job when Strict Mode replays and aborts the first effect", async () => {
    vi.restoreAllMocks();
    const completed = {
      ...job,
      status: "completed" as const,
      progress: { ...job.progress, eligibleAccessPointCount: 1, processedAccessPointCount: 1, exactRouteCount: 1 },
      completedAt: "2026-08-06T00:00:05Z",
    };
    let restoreRequests = 0;
    mockBaseFetch((url, init) => {
      if (url !== `/api/route-jobs/${completed.id}/results?limit=50`) return undefined;
      restoreRequests += 1;
      if (restoreRequests === 1) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return new Response(JSON.stringify({
        version: 1,
        job: completed,
        results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }],
      }), { status: 200 });
    });

    render(<StrictMode><HikeBuilder restoreJobId={completed.id} /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(restoreRequests).toBe(2);
  });

  it("does not apply a linked job restore after the workspace changes", async () => {
    vi.restoreAllMocks();
    const completed = {
      ...job,
      status: "completed" as const,
      progress: { ...job.progress, eligibleAccessPointCount: 1, processedAccessPointCount: 1, exactRouteCount: 1 },
      completedAt: "2026-08-06T00:00:05Z",
    };
    const restore = deferred<Response>();
    let restoreSignal: AbortSignal | undefined;
    mockBaseFetch((url, init) => {
      if (url !== `/api/route-jobs/${completed.id}/results?limit=50`) return undefined;
      restoreSignal = init?.signal ?? undefined;
      return restore.promise;
    });

    render(<HikeBuilder restoreJobId={completed.id} />);
    await waitFor(() => expect(restoreSignal).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    expect(restoreSignal?.aborted).toBe(true);

    restore.resolve(new Response(JSON.stringify({
      version: 1,
      job: completed,
      results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }],
    }), { status: 200 }));
    await act(async () => { await restore.promise; });

    expect(screen.queryByRole("heading", { name: "Exact matches" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("");
  });

  it("finishes pagination loading after advancing a saved result page", async () => {
    vi.restoreAllMocks();
    const completed = {
      ...job,
      status: "completed" as const,
      progress: { ...job.progress, eligibleAccessPointCount: 2, processedAccessPointCount: 2, exactRouteCount: 2 },
      completedAt: "2026-08-06T00:00:05Z",
    };
    const firstPage = {
      version: 1,
      job: completed,
      results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }],
      nextCursor: "cursor-1",
    };
    const secondPage = {
      version: 1,
      job: completed,
      results: [{
        matchType: "exact",
        accessPointId: "trailhead-b",
        route: { ...generatedRoute, id: "second-route" },
      }],
    };
    mockBaseFetch((url, init) => {
      if (url === "/api/route-jobs" && !init?.method) {
        return new Response(JSON.stringify({ version: 1, jobs: [completed] }), { status: 200 });
      }
      if (url === `/api/route-jobs/${completed.id}/results?limit=50`) {
        return new Response(JSON.stringify(firstPage), { status: 200 });
      }
      if (url === `/api/route-jobs/${completed.id}/results?limit=50&cursor=cursor-1`) {
        return new Response(JSON.stringify(secondPage), { status: 200 });
      }
      return undefined;
    });

    render(<HikeBuilder />);
    await userEvent.click(await screen.findByRole("button", { name: "Jobs" }));
    await userEvent.click(await screen.findByRole("button", { name: `View results for ${searchRegion.name}` }));
    await userEvent.click(await screen.findByRole("button", { name: "Next 50 routes" }));

    expect(await screen.findByRole("button", { name: "Last page" })).toBeDisabled();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("second-route");
  });

  it("remounts the workspace for a new pack so pack-specific draft and results state reset", async () => {
    const view = render(<HikeBuilder key="fixture-pack" />);
    await userEvent.selectOptions(screen.getByLabelText("Typical drive time"), "45");
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    expect(await screen.findByRole("heading", { name: "Exact matches" })).toBeVisible();

    const nextPack = { ...FIXTURE_BUILDER_PACK, id: "southern-east-bay", name: "Southern East Bay" };
    view.rerender(<HikeBuilder key="southern-east-bay" pack={nextPack} regions={[]} />);
    expect(screen.getByLabelText("Typical drive time")).toHaveValue("30");
    expect(screen.queryByRole("heading", { name: "Exact matches" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("");
  });

  it("shows one shared builder with both explicit actions", async () => {
    render(<HikeBuilder />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Driving origin")).toBeVisible();
    expect(screen.getByLabelText("Typical drive time")).toHaveValue("30");
    expect(await screen.findByRole("button", { name: /Regions: Santa Cruz Mountains/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Quick search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Full search" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Drawn boundary" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(10);
    expect(screen.queryByLabelText("Search effort")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Include uncertain trail access" })).toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Show region boundaries" }));
    expect(screen.getByRole("switch", { name: "Show region boundaries" })).toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Include uncertain trail access" }));
    expect(screen.getByRole("switch", { name: "Include uncertain trail access" })).not.toBeChecked();
    await userEvent.clear(screen.getByLabelText("Quick-search routes"));
    await userEvent.type(screen.getByLabelText("Quick-search routes"), "12");
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(12);
  });

  it("updates drive-time and closed-route controls without retaining synthetic events", async () => {
    render(<HikeBuilder />);
    await userEvent.selectOptions(screen.getByLabelText("Typical drive time"), "45");
    expect(screen.getByLabelText("Typical drive time")).toHaveValue("45");
    const loopOptions = screen.getByText("Loop options").closest("details") as HTMLDetailsElement;
    loopOptions.open = true;
    fireEvent.change(screen.getByLabelText("Maximum repeated trail"), { target: { value: "20" } });
    fireEvent.blur(screen.getByLabelText("Maximum repeated trail"));
    expect(screen.getByLabelText("Maximum repeated trail")).toHaveValue(20);
    expect(screen.getByLabelText("Maximum shared approach")).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Shared approach" }));
    expect(screen.getByLabelText("Maximum shared approach")).toBeEnabled();
    await userEvent.clear(screen.getByLabelText("Maximum shared approach"));
    await userEvent.type(screen.getByLabelText("Maximum shared approach"), "2.5");
    await userEvent.tab();
    expect(screen.getByLabelText("Maximum shared approach")).toHaveValue(2.5);
    await userEvent.click(screen.getByRole("switch", { name: /Allow figure-eights/ }));
    expect(screen.getByRole("switch", { name: /Allow figure-eights/ })).not.toBeChecked();
    const savedLoopOptions = vi.mocked(globalThis.fetch).mock.calls
      .filter(([input, init]) => String(input) === "/api/settings" && init?.method === "PUT")
      .map(([, init]) => JSON.parse(String(init?.body)).loopOptions)
      .at(-1);
    expect(savedLoopOptions).toEqual({ maximumRepeatedTrailPct: 20, sharedApproachEnabled: true, maximumSharedApproachMiles: 2.5, allowMultiCycle: false });
  });

  it("resolves the compact grade preset into numeric constraints and persists edits", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Grade" }));
    await userEvent.selectOptions(screen.getByLabelText("Grade preset"), "steep");
    expect(screen.getByLabelText("Selected climbing grade")).toHaveTextContent("18%");
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await screen.findByText("1 exact route ready.");
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/routes/generate");
    expect(JSON.parse(String(generationCall?.[1]?.body))).toMatchObject({ gradeExperience: appSettings.gradePresets.steep });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/settings" && init?.method === "PUT")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.clear(screen.getByLabelText("Moderate climb grade"));
    await userEvent.type(screen.getByLabelText("Moderate climb grade"), "13");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    const saves = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/settings" && init?.method === "PUT");
    expect(JSON.parse(String(saves.at(-1)?.[1]?.body))).toMatchObject({ includeUncertainAccess: true, quickSearchRouteCount: 10, gradePresets: { moderate: { maximumClimbP90Pct: 13 } } });
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

  it("clears current results and their map traces from the results header", async () => {
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    expect(await screen.findByRole("heading", { name: "Exact matches" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Clear results" }));

    expect(screen.queryByRole("heading", { name: "Results" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("");
  });

  it("removes the abort listener after a reachability poll delay completes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const pending = waitForPoll(250, controller.signal);

    vi.advanceTimersByTime(250);
    await pending;

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("resolves drive time before Quick when no boundary is drawn", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    expect(await screen.findByRole("button", { name: "Regions: Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    expect(await screen.findByText("1 exact route ready.")).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reachability")).toBe(true);
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/routes/generate");
    expect(JSON.parse(String(generationCall?.[1]?.body))).toMatchObject({
      searchEffort: "quick",
      accessFilter: { mode: "drive-time", reachabilityId: "3d594650-3436-4f8b-a0e8-38d13fc148ca", regionId: searchRegion.id },
    });
  });

  it("runs Quick across every selected pack and labels the combined results", async () => {
    vi.restoreAllMocks();
    const generatedPackIds: string[] = [];
    mockBaseFetch((url, init) => {
      if (url !== "/api/routes/generate") return undefined;
      const request = JSON.parse(String(init?.body)) as { packId: string };
      generatedPackIds.push(request.packId);
      const eastBay = request.packId === "southern-east-bay";
      return new Response(JSON.stringify({
        ...routeResponse,
        requestId: eastBay ? "request-east-bay" : "request-fixture",
        pack: { ...routeResponse.pack, id: request.packId },
        exact: [{
          ...generatedRoute,
          id: eastBay ? "east-bay-route" : "fixture-route",
          geometry: eastBay
            ? { type: "LineString", coordinates: [[-121.96, 37.46], [-121.9, 37.5], [-121.96, 37.46]] }
            : generatedRoute.geometry,
        }],
      }), { status: 200 });
    });

    render(<HikeBuilder regions={catalogRegions} />);
    await userEvent.click(screen.getByRole("button", { name: /Southern East Bay.*Available/ }));
    expect(await screen.findByRole("button", { name: "Regions: 2 regions selected" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));

    expect(await screen.findByText("2 exact routes ready.")).toBeVisible();
    expect(generatedPackIds).toEqual(["fixture-pack", "southern-east-bay"]);
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("fixture-pack::fixture-route");
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("southern-east-bay::east-bay-route");
    expect(screen.getByText("Southern East Bay · Santa Cruz Mountains")).toBeVisible();
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
    expect(await screen.findByRole("button", { name: "Regions: Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Full search" }));
    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    const launch = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/route-jobs" && init?.method === "POST");
    expect(JSON.parse(String(launch?.[1]?.body))).toMatchObject({ version: 1, packId: "fixture-pack", origin: { lon: -122.16, lat: 37.16, label: "37.16000, -122.16000" }, durationMinutes: 30, searchRegionId: searchRegion.id, routesPerAccessPoint: 10, criteria: { distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true } });
    expect(screen.queryByLabelText("Access point")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Calculate drive-time/ })).not.toBeInTheDocument();
  });

  it("launches a region-wide Full search without an origin or reachability request", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/route-jobs" && init?.method === "POST") {
        return new Response(JSON.stringify({ job: { ...job, request: regionWideJobRequest } }), { status: 202 });
      }
      if (url === "/api/route-jobs") return new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 });
      if (url.includes("/search-regions")) return new Response(JSON.stringify({ searchRegions: [searchRegion] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });

    render(<HikeBuilder />);
    expect(await screen.findByRole("button", { name: "Regions: Santa Cruz Mountains" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Full search" }));

    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    const launch = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/route-jobs" && init?.method === "POST");
    const payload = JSON.parse(String(launch?.[1]?.body));
    expect(payload).toMatchObject({ version: 1, packId: "fixture-pack", searchRegionId: searchRegion.id, routesPerAccessPoint: 10 });
    expect(payload).not.toHaveProperty("origin");
    expect(payload).not.toHaveProperty("durationMinutes");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/reachability"))).toBe(false);
  });

  it("does not silently launch region-wide when typed origin text is unresolved", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    expect(await screen.findByRole("button", { name: "Regions: Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "Unresolved place");
    await userEvent.click(screen.getByRole("button", { name: "Full search" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Choose a suggested origin or clear the field to search the entire reviewed region.");
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/route-jobs" && init?.method === "POST")).toBe(false);
  });

  it("launches one Full search for each selected reviewed region", async () => {
    vi.restoreAllMocks();
    const launchedPackIds: string[] = [];
    mockBaseFetch((url, init) => {
      if (url !== "/api/route-jobs" || init?.method !== "POST") return undefined;
      const request = JSON.parse(String(init.body)) as { packId: string };
      launchedPackIds.push(request.packId);
      const eastBay = request.packId === "southern-east-bay";
      return new Response(JSON.stringify({ job: {
        ...job,
        id: eastBay ? "4d594650-3436-4f8b-a0e8-38d13fc148ca" : job.id,
        request: { ...job.request, packId: request.packId },
        pack: { ...job.pack, id: request.packId },
      } }), { status: 202 });
    });

    render(<HikeBuilder regions={catalogRegions} />);
    await userEvent.click(screen.getByRole("button", { name: /Southern East Bay.*Available/ }));
    expect(await screen.findByRole("button", { name: "Regions: 2 regions selected" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Full search" }));

    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    expect(launchedPackIds).toEqual(["fixture-pack", "southern-east-bay"]);
    expect(screen.getByText(/2 full searches queued/)).toBeVisible();
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

  it("does not keep polling after the initial refresh when no job is active", async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    let listRequests = 0;
    mockBaseFetch((url, init) => {
      if (url === "/api/route-jobs" && !init?.method) {
        listRequests += 1;
        return new Response(JSON.stringify({ version: 1, jobs: [] }), { status: 200 });
      }
      return undefined;
    });
    render(<HikeBuilder />);
    await act(async () => undefined);
    expect(listRequests).toBe(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(listRequests).toBe(1);
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
    expect(await screen.findByRole("button", { name: "Regions: Santa Cruz Mountains" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    const launch = screen.getByRole("button", { name: "Full search" });
    fireEvent.click(launch);
    fireEvent.click(launch);
    expect(launches).toBe(1);
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();

    launchResponse.resolve(new Response(JSON.stringify({ job }), { status: 202 }));
    expect(await screen.findByRole("dialog", { name: "Jobs" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Full search" })).toBeEnabled();
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
