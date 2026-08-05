import { describe, expect, it, vi } from "vitest";
import type {
  GeneratedRouteV2,
  GenerateRoutesRequestV2,
  GenerateRoutesResponseV2,
  NamedArea,
} from "@/lib/contracts";
import type { GraphRepository, InducedGraph } from "@/lib/graph";
import {
  AccessFilterResolutionError,
  type RouteGenerationV2Context,
  type RouteSolverV2,
  type SolverBudget,
} from "@/lib/solver";
import {
  createGenerateRoutesHandler,
  type RoutePack,
} from "@/lib/server/route-generation";

const PACK_METADATA = {
  id: "fixture-pack",
  schemaVersion: "2",
  dataVersion: "fixture-v2",
  builtAt: "2026-08-04T00:00:00Z",
} as const;

const COVERAGE = {
  type: "Polygon" as const,
  coordinates: [[
    [-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37],
  ]],
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
    coordinates: [
      [[-122.19, 37.14], [-122.13, 37.14], [-122.13, 37.2], [-122.19, 37.2], [-122.19, 37.14]],
      [[-122.17, 37.16], [-122.16, 37.16], [-122.16, 37.17], [-122.17, 37.17], [-122.17, 37.16]],
    ],
  },
};

const VALID_REQUEST: GenerateRoutesRequestV2 = {
  version: 2,
  packId: PACK_METADATA.id,
  accessFilter: { mode: "drawn-area", bbox: [-122.18, 37.15, -122.13, 37.18] },
  routeTypes: ["loop"],
  pointToPoint: { finishMustMatchAccessFilter: true },
  distanceMiles: { min: 1, max: 5 },
  includeUncertainAccess: false,
  limit: 2,
};

const ROUTE: GeneratedRouteV2 = {
  id: "loop_fixture",
  shape: "loop",
  geometry: {
    type: "LineString",
    coordinates: [[-122.16, 37.16], [-122.2, 37.19], [-122.16, 37.16]],
  },
  startAccessPoint: {
    id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16,
    accessState: "public", confidence: "high",
  },
  endAccessPoint: {
    id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16,
    accessState: "public", confidence: "high",
  },
  distanceMeters: 3_200,
  elevationGainMeters: 110,
  elevationLossMeters: 110,
  minimumElevationMeters: 100,
  maximumElevationMeters: 150,
  steepestSustainedGradePct: 8,
  repeatedEdgeFraction: 0,
  trailNames: ["Fixture Loop"],
  warnings: [],
  source: { freshness: PACK_METADATA.builtAt, confidence: "high", sourceIds: ["fixture-source"] },
  filterMatch: { start: true, end: true },
};

const TEST_BUDGET: SolverBudget = {
  maximumDirectedEdges: 10_000,
  maximumExpandedStates: 100_000,
  deadlineMs: 500,
  maximumRawCandidates: 2_000,
};

class TestRepository implements GraphRepository {
  readonly packId = PACK_METADATA.id;
  close = vi.fn(async () => undefined);
  async getInducedGraph(): Promise<InducedGraph> { return { nodes: new Map(), edges: [], accessPoints: [] }; }
  async getAccessPoints(): Promise<[]> { return []; }
  async getAccessPointCandidates(): Promise<[]> { return []; }
  async getReachableGraph() { return { graph: await this.getInducedGraph(), truncated: false }; }
}

function testPack(overrides: Partial<RoutePack> = {}): RoutePack {
  return {
    ...PACK_METADATA,
    coverageBbox: [-123, 37, -122, 38],
    coverage: COVERAGE,
    maximumAreaSquareKilometers: 100,
    getNamedArea: async (id) => id === REGION.id ? REGION : null,
    searchNamedAreas: async () => [],
    loadRepository: async () => new TestRepository(),
    ...overrides,
  };
}

function responseFor(
  request: GenerateRoutesRequestV2,
  context: RouteGenerationV2Context,
  overrides: Partial<GenerateRoutesResponseV2> = {},
): GenerateRoutesResponseV2 {
  return {
    version: 2,
    requestId: "request-fixture",
    pack: PACK_METADATA,
    requested: request.limit,
    resolvedAccessFilter: context.accessFilter.summary,
    exact: [ROUTE, { ...ROUTE, id: "loop_fixture_alternative" }].slice(0, request.limit),
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
    },
    ...overrides,
  };
}

function dynamicSolver(
  implementation: (request: GenerateRoutesRequestV2, context: RouteGenerationV2Context) => Promise<GenerateRoutesResponseV2>
    = async (request, context) => responseFor(request, context),
): RouteSolverV2 {
  return { generate: vi.fn(implementation) };
}

function handlerFor(options: {
  solver?: RouteSolverV2;
  pack?: RoutePack;
  resolveReachability?: Parameters<typeof createGenerateRoutesHandler>[0]["resolveReachability"];
} = {}) {
  const pack = options.pack ?? testPack();
  return createGenerateRoutesHandler({
    packs: new Map([[pack.id, pack]]),
    solver: options.solver ?? dynamicSolver(),
    resolveReachability: options.resolveReachability ?? (async () => ({
      geometry: REGION.geometry,
      durationMinutes: 30,
      resolvedAt: "2026-08-04T00:00:00Z",
      originLabel: "San Jose, CA",
    })),
    budget: TEST_BUDGET,
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

describe("POST /api/routes/generate V2", () => {
  it("rejects malformed JSON, strict extras, and version 1", async () => {
    expect(await errorCode(await handlerFor()(jsonRequest("{", true)))).toBe("MALFORMED_JSON");
    expect(await errorCode(await handlerFor()(jsonRequest({ ...VALID_REQUEST, unexpected: true })))).toBe("INVALID_REQUEST");
    expect(await errorCode(await handlerFor()(jsonRequest({ version: 1, packId: "fixture-pack" })))).toBe("UNSUPPORTED_REQUEST_VERSION");
  });

  it("resolves a drawn filter while allowing routes to leave it but stay in pack coverage", async () => {
    const solver = dynamicSolver();
    const response = await handlerFor({ solver })(jsonRequest());
    expect(response.status).toBe(200);
    expect((await response.json() as GenerateRoutesResponseV2).exact[0]?.geometry.coordinates[1]).toEqual([-122.2, 37.19]);
    const context = vi.mocked(solver.generate).mock.calls[0]?.[1];
    expect(context?.accessFilter.coverage).toEqual(COVERAGE);
    expect(context?.accessFilter.predicates).toHaveLength(1);
  });

  it("resolves named, drive, and drive-plus-region predicates", async () => {
    const namedSolver = dynamicSolver();
    const named = await handlerFor({ solver: namedSolver })(jsonRequest({
      ...VALID_REQUEST,
      accessFilter: { mode: "named-region", regionId: REGION.id },
    }));
    expect(named.status).toBe(200);
    expect((await named.json() as GenerateRoutesResponseV2).resolvedAccessFilter.region?.name).toBe(REGION.name);
    expect(vi.mocked(namedSolver.generate).mock.calls[0]?.[1].accessFilter.predicates[0]).toEqual(REGION.geometry);

    const driveSolver = dynamicSolver();
    const driveRequest = {
      ...VALID_REQUEST,
      accessFilter: { mode: "drive-time" as const, reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc" },
    };
    expect((await (await handlerFor({ solver: driveSolver })(jsonRequest(driveRequest))).json() as GenerateRoutesResponseV2)
      .resolvedAccessFilter.driveTime?.minutes).toBe(30);
    expect(vi.mocked(driveSolver.generate).mock.calls[0]?.[1].accessFilter.predicates).toHaveLength(1);

    const refinedSolver = dynamicSolver();
    await handlerFor({ solver: refinedSolver })(jsonRequest({
      ...driveRequest,
      accessFilter: { ...driveRequest.accessFilter, regionId: REGION.id },
    }));
    expect(vi.mocked(refinedSolver.generate).mock.calls[0]?.[1].accessFilter.predicates).toHaveLength(2);
  });

  it("maps named and reachability lookup states distinctly", async () => {
    expect(await errorCode(await handlerFor()(jsonRequest({
      ...VALID_REQUEST, accessFilter: { mode: "named-region", regionId: "missing" },
    })))).toBe("NAMED_AREA_NOT_FOUND");
    for (const [thrown, expected] of [
      ["REACHABILITY_NOT_FOUND", "REACHABILITY_NOT_FOUND"],
      ["REACHABILITY_EXPIRED", "REACHABILITY_EXPIRED"],
      ["REACHABILITY_PENDING", "REACHABILITY_PENDING"],
    ] as const) {
      const response = await handlerFor({
        resolveReachability: async () => { throw Object.assign(new Error(thrown), { code: thrown }); },
      })(jsonRequest({
        ...VALID_REQUEST,
        accessFilter: { mode: "drive-time", reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc" },
      }));
      expect(await errorCode(response)).toBe(expected);
    }
  });

  it("maps explicit-start errors separately and accepts a valid zero-eligible response", async () => {
    for (const code of ["START_NOT_FOUND", "START_OUTSIDE_FILTER", "START_INELIGIBLE"] as const) {
      const response = await handlerFor({
        solver: dynamicSolver(async () => { throw new AccessFilterResolutionError(code, code); }),
      })(jsonRequest({ ...VALID_REQUEST, startAccessPointId: "selected" }));
      expect(await errorCode(response)).toBe(code);
    }
    const emptySolver = dynamicSolver(async (request, context) => responseFor(request, context, {
      exact: [],
      diagnostics: {
        elapsedMs: 1, expandedStates: 0, candidateCount: 0,
        eligibleAccessPointCount: 0, searchedAccessPointCount: 0, graphQueryCount: 0,
        maximumLoadedDirectedEdges: 0, exhausted: false, truncationReasons: [],
        shortfallReasons: ["no-eligible-start-access-points", "fewer-exact-routes-than-requested"],
      },
    }));
    expect((await handlerFor({ solver: emptySolver })(jsonRequest())).status).toBe(200);
  });

  it("rejects solver routes outside exact pack coverage and malformed/underexplained responses", async () => {
    const outside = { ...ROUTE, geometry: { type: "LineString" as const, coordinates: [[-122.16, 37.16], [-121, 37.2]] as [number, number][] } };
    const outsideSolver = dynamicSolver(async (request, context) => responseFor(request, context, { exact: [outside] }));
    expect(await errorCode(await handlerFor({ solver: outsideSolver })(jsonRequest({ ...VALID_REQUEST, limit: 1 })))).toBe("INVALID_SOLVER_RESPONSE");

    const underexplained = dynamicSolver(async (request, context) => responseFor(request, context, { exact: [] }));
    expect(await errorCode(await handlerFor({ solver: underexplained })(jsonRequest()))).toBe("INVALID_SOLVER_RESPONSE");
  });

  it("propagates cancellation and always closes the repository", async () => {
    const repository = new TestRepository();
    const solver = dynamicSolver(async () => { throw new DOMException("cancelled", "AbortError"); });
    const response = await handlerFor({ pack: testPack({ loadRepository: async () => repository }), solver })(jsonRequest());
    expect(await errorCode(response)).toBe("REQUEST_CANCELLED");
    expect(repository.close).toHaveBeenCalledOnce();
  });
});
