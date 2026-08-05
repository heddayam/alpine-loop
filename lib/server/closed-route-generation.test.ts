import { describe, expect, it, vi } from "vitest";
import type {
  GeneratedClosedRouteV3,
  GenerateClosedRoutesRequestV3,
  GenerateClosedRoutesResponseV3,
  NamedArea,
} from "@/lib/contracts";
import type {
  AccessTopology,
  ClosedRouteFeasibilityRepository,
  GraphRepository,
  InducedGraph,
} from "@/lib/graph";
import {
  AccessFilterResolutionError,
  type ReachableGraphClosedRouteContext,
  type SolverBudget,
} from "@/lib/solver";
import {
  createGenerateClosedRoutesHandler,
  type ClosedRoutePack,
  type ClosedRouteSolverV3,
} from "./closed-route-generation";

const PACK_METADATA = {
  id: "fixture-pack",
  schemaVersion: "3" as const,
  dataVersion: "fixture-v3",
  builtAt: "2026-08-04T00:00:00Z",
};

const COVERAGE = {
  type: "Polygon" as const,
  coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]],
};

const REGION: NamedArea = {
  id: "osm:relation/42",
  name: "Redwood Preserve",
  kind: "preserve",
  context: "California",
  bbox: [-122.19, 37.14, -122.13, 37.2],
  sourceIds: ["osm"],
  geometry: {
    type: "Polygon",
    coordinates: [[[-122.19, 37.14], [-122.13, 37.14], [-122.13, 37.2], [-122.19, 37.2], [-122.19, 37.14]]],
  },
};

const VALID_REQUEST: GenerateClosedRoutesRequestV3 = {
  version: 3,
  packId: PACK_METADATA.id,
  accessFilter: { mode: "drawn-area", bbox: [-122.18, 37.15, -122.13, 37.18] },
  routeFamily: "closed",
  closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
  distanceMiles: { min: 1, max: 5 },
  includeUncertainAccess: false,
  searchEffort: "thorough",
  limit: 1,
};

const ROUTE: GeneratedClosedRouteV3 = {
  id: "closed_fixture",
  geometry: {
    type: "LineString",
    coordinates: [[-122.16, 37.16], [-122.2, 37.19], [-122.16, 37.16]],
  },
  startAccessPoint: {
    id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16,
    accessState: "public", confidence: "high",
  },
  distanceMeters: 3_200,
  elevationGainMeters: 110,
  elevationLossMeters: 110,
  minimumElevationMeters: 100,
  maximumElevationMeters: 150,
  steepestSustainedGradePct: 8,
  topology: {
    kind: "simple-loop",
    cycleCount: 1,
    cycleBlockCount: 1,
    repeatedTrailDistanceMeters: 0,
    repeatedTrailFraction: 0,
    sharedStemDistanceMeters: 0,
    connectorCount: 0,
  },
  trailNames: ["Fixture Loop"],
  warnings: [],
  source: { freshness: PACK_METADATA.builtAt, confidence: "high", sourceIds: ["fixture-source"] },
};

const QUICK_BUDGET: SolverBudget = {
  maximumDirectedEdges: 111,
  maximumExpandedStates: 222,
  deadlineMs: 500,
  maximumRawCandidates: 333,
};
const THOROUGH_BUDGET: SolverBudget = {
  maximumDirectedEdges: 444,
  maximumExpandedStates: 555,
  deadlineMs: 800,
  maximumRawCandidates: 666,
};

class TestGraphRepository implements GraphRepository {
  readonly packId = PACK_METADATA.id;
  close = vi.fn(async () => undefined);
  async getInducedGraph(): Promise<InducedGraph> { return { nodes: new Map(), edges: [], accessPoints: [] }; }
  async getAccessPoints(): Promise<[]> { return []; }
  async getAccessPointCandidates(): Promise<[]> { return []; }
  async getReachableGraph() { return { graph: await this.getInducedGraph(), truncated: false }; }
}

class TestFeasibilityRepository implements ClosedRouteFeasibilityRepository {
  readonly packId = PACK_METADATA.id;
  readonly dataVersion = PACK_METADATA.dataVersion;
  close = vi.fn(async () => undefined);
  async getAccessTopology(): Promise<AccessTopology[]> { return []; }
}

function testPack(overrides: Partial<ClosedRoutePack> = {}): ClosedRoutePack {
  return {
    ...PACK_METADATA,
    coverageBbox: [-123, 37, -122, 38],
    coverage: COVERAGE,
    maximumAreaSquareKilometers: 100,
    getNamedArea: async (id) => id === REGION.id ? REGION : null,
    searchNamedAreas: async () => [],
    closedRouteRuntimeMode: "reachable-graph-fallback",
    loadRepository: async () => new TestGraphRepository(),
    loadClosedRouteFeasibilityRepository: async () => new TestFeasibilityRepository(),
    ...overrides,
  };
}

function responseFor(
  request: GenerateClosedRoutesRequestV3,
  context: ReachableGraphClosedRouteContext,
  overrides: Partial<GenerateClosedRoutesResponseV3> = {},
): GenerateClosedRoutesResponseV3 {
  return {
    version: 3,
    requestId: "request-fixture",
    pack: PACK_METADATA,
    requested: request.limit,
    resolvedAccessFilter: context.accessFilter.summary,
    exact: [ROUTE],
    nearMisses: [],
    diagnostics: {
      elapsedMs: 12,
      expandedStates: 42,
      candidateCount: 4,
      eligibleAccessPointCount: 2,
      searchedAccessPointCount: 2,
      graphQueryCount: 2,
      maximumLoadedDirectedEdges: 12,
      exhausted: false,
      truncationReasons: [],
      shortfallReasons: [],
      noCycleAccessPointCount: 0,
      feasibleAccessPointCount: 2,
      attachmentGroupCount: 2,
      probedAttachmentGroupCount: 2,
      deeplySearchedAttachmentGroupCount: 2,
      loadedTopologyNetworkCount: 0,
      cycleBlockCount: 0,
      cyclePrimitiveCount: 0,
      composedCandidateCount: 4,
      repairedCandidateCount: 0,
      directedValidationRejectionCount: 0,
      expandedAssemblyStates: 42,
      timeToFirstExactMs: 5,
      hardTruncationReasons: [],
      nonBudgetShortfallReasons: [],
    },
    ...overrides,
  };
}

function dynamicSolver(
  implementation: (
    request: GenerateClosedRoutesRequestV3,
    context: ReachableGraphClosedRouteContext,
  ) => Promise<GenerateClosedRoutesResponseV3> = async (request, context) => responseFor(request, context),
): ClosedRouteSolverV3 {
  return { generate: vi.fn(implementation) };
}

function handlerFor(options: {
  solver?: ClosedRouteSolverV3;
  pack?: ClosedRoutePack;
  resolveReachability?: Parameters<typeof createGenerateClosedRoutesHandler>[0]["resolveReachability"];
} = {}) {
  const pack = options.pack ?? testPack();
  return createGenerateClosedRoutesHandler({
    packs: new Map([[pack.id, pack]]),
    createSolver: async () => options.solver ?? dynamicSolver(),
    resolveReachability: options.resolveReachability ?? (async () => ({
      geometry: REGION.geometry,
      durationMinutes: 30,
      resolvedAt: "2026-08-04T00:00:00Z",
      originLabel: "San Jose, CA",
    })),
    budgets: { quick: QUICK_BUDGET, thorough: THOROUGH_BUDGET },
  });
}

function jsonRequest(body: unknown = VALID_REQUEST, raw = false, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/routes/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
    signal,
  });
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { error: { code: string } }).error.code;
}

describe("V3 closed-route generation handler", () => {
  it("rejects malformed, extra, legacy, and unsupported-pack requests", async () => {
    expect(await errorCode(await handlerFor()(jsonRequest("{", true)))).toBe("MALFORMED_JSON");
    expect(await errorCode(await handlerFor()(jsonRequest({ ...VALID_REQUEST, unexpected: true })))).toBe("INVALID_REQUEST");
    expect(await errorCode(await handlerFor()(jsonRequest({ version: 2, packId: PACK_METADATA.id })))).toBe("UNSUPPORTED_REQUEST_VERSION");
    const unsupported = testPack({ schemaVersion: "2", closedRouteRuntimeMode: undefined, loadClosedRouteFeasibilityRepository: undefined });
    expect(await errorCode(await handlerFor({ pack: unsupported })(jsonRequest()))).toBe("CLOSED_ROUTES_UNAVAILABLE");
  });

  it("uses the selected effort budget, allows routes outside the filter, and closes both repositories", async () => {
    const graph = new TestGraphRepository();
    const feasibility = new TestFeasibilityRepository();
    const solver = dynamicSolver();
    const pack = testPack({
      loadRepository: async () => graph,
      loadClosedRouteFeasibilityRepository: async () => feasibility,
    });
    const response = await handlerFor({ pack, solver })(jsonRequest({ ...VALID_REQUEST, searchEffort: "quick" }));
    expect(response.status).toBe(200);
    expect((await response.json() as GenerateClosedRoutesResponseV3).exact[0]?.geometry.coordinates[1]).toEqual([-122.2, 37.19]);
    const context = vi.mocked(solver.generate).mock.calls[0]?.[1];
    expect(context?.budget).toEqual(QUICK_BUDGET);
    expect(context?.accessFilter.coverage).toEqual(COVERAGE);
    expect(context?.accessFilter.predicates).toHaveLength(1);
    expect(graph.close).toHaveBeenCalledOnce();
    expect(feasibility.close).toHaveBeenCalledOnce();
  });

  it("resolves named, drive-time, and refined drive-time filters", async () => {
    const namedSolver = dynamicSolver();
    const named = await handlerFor({ solver: namedSolver })(jsonRequest({
      ...VALID_REQUEST,
      accessFilter: { mode: "named-region", regionId: REGION.id },
    }));
    expect(named.status).toBe(200);
    expect(vi.mocked(namedSolver.generate).mock.calls[0]?.[1].accessFilter.predicates).toEqual([REGION.geometry]);

    const driveSolver = dynamicSolver();
    const drive = await handlerFor({ solver: driveSolver })(jsonRequest({
      ...VALID_REQUEST,
      accessFilter: {
        mode: "drive-time",
        reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc",
        regionId: REGION.id,
      },
    }));
    expect(drive.status).toBe(200);
    expect(vi.mocked(driveSolver.generate).mock.calls[0]?.[1].accessFilter.predicates).toHaveLength(2);
  });

  it("maps explicit-start errors without disguising them", async () => {
    for (const code of ["START_NOT_FOUND", "START_OUTSIDE_FILTER", "START_INELIGIBLE"] as const) {
      const response = await handlerFor({
        solver: dynamicSolver(async () => { throw new AccessFilterResolutionError(code, code); }),
      })(jsonRequest({ ...VALID_REQUEST, startAccessPointId: "selected" }));
      expect(await errorCode(response)).toBe(code);
    }
  });

  it("rejects out-of-coverage, open, underexplained, and contradictory solver responses", async () => {
    const invalidResponses: Array<Partial<GenerateClosedRoutesResponseV3>> = [
      { exact: [{ ...ROUTE, geometry: { type: "LineString", coordinates: [[-122.16, 37.16], [-121, 37.2], [-122.16, 37.16]] } }] },
      { exact: [{ ...ROUTE, geometry: { type: "LineString", coordinates: [[-122.16, 37.16], [-122.15, 37.17]] } }] },
      { exact: [], diagnostics: { ...responseFor(VALID_REQUEST, { accessFilter: { summary: { mode: "drawn-area", label: "Drawn area" }, predicates: [], coverage: COVERAGE }, budget: THOROUGH_BUDGET, repository: new TestGraphRepository(), topologyRepository: new TestFeasibilityRepository() }).diagnostics } },
      { diagnostics: { ...responseFor(VALID_REQUEST, { accessFilter: { summary: { mode: "drawn-area", label: "Drawn area" }, predicates: [], coverage: COVERAGE }, budget: THOROUGH_BUDGET, repository: new TestGraphRepository(), topologyRepository: new TestFeasibilityRepository() }).diagnostics, hardTruncationReasons: ["deadline"] } },
    ];
    for (const overrides of invalidResponses) {
      const solver = dynamicSolver(async (request, context) => responseFor(request, context, overrides));
      expect(await errorCode(await handlerFor({ solver })(jsonRequest()))).toBe("INVALID_SOLVER_RESPONSE");
    }
  });

  it("maps pack-open failures, deadline expiry, and client cancellation while closing opened repositories", async () => {
    const openedGraph = new TestGraphRepository();
    const unavailable = testPack({
      loadRepository: async () => openedGraph,
      loadClosedRouteFeasibilityRepository: async () => { throw new Error("corrupt"); },
    });
    expect(await errorCode(await handlerFor({ pack: unavailable })(jsonRequest()))).toBe("PACK_UNAVAILABLE");
    expect(openedGraph.close).toHaveBeenCalledOnce();

    const deadlineSolver = dynamicSolver(async (_request, context) => new Promise((_, reject) => {
      context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
    }));
    const deadlineHandler = createGenerateClosedRoutesHandler({
      packs: new Map([[PACK_METADATA.id, testPack()]]),
      createSolver: () => deadlineSolver,
      resolveReachability: async () => { throw new Error("unused"); },
      budgets: { quick: { ...QUICK_BUDGET, deadlineMs: 10 }, thorough: { ...THOROUGH_BUDGET, deadlineMs: 10 } },
    });
    expect(await errorCode(await deadlineHandler(jsonRequest()))).toBe("DEADLINE_EXCEEDED");

    const controller = new AbortController();
    const cancellationSolver = dynamicSolver(async (_request, context) => new Promise((_, reject) => {
      context.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      controller.abort();
    }));
    expect(await errorCode(await handlerFor({ solver: cancellationSolver })(jsonRequest(VALID_REQUEST, false, controller.signal)))).toBe("REQUEST_CANCELLED");
  });
});
