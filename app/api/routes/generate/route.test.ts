import { describe, expect, it, vi } from "vitest";
import type {
  GeneratedRoute,
  GenerateRoutesRequestV1,
  GenerateRoutesResponseV1,
} from "@/lib/contracts";
import type { GraphRepository, InducedGraph } from "@/lib/graph";
import type { RouteSolver, SolverBudget } from "@/lib/solver";
import {
  createGenerateRoutesHandler,
  type RoutePack,
} from "@/lib/server/route-generation";

const PACK_METADATA = {
  id: "fixture-pack",
  schemaVersion: "1",
  dataVersion: "fixture-v1",
  builtAt: "2026-08-04T00:00:00Z",
} as const;

const VALID_REQUEST: GenerateRoutesRequestV1 = {
  version: 1,
  packId: PACK_METADATA.id,
  bbox: [-122.18, 37.15, -122.13, 37.18],
  startAccessPointId: "trailhead-a",
  routeTypes: ["loop"],
  distanceMiles: { min: 1, max: 5 },
  includeUncertainAccess: false,
  limit: 2,
};

const ROUTE: GeneratedRoute = {
  id: "loop_fixture",
  shape: "loop",
  geometry: {
    type: "LineString",
    coordinates: [
      [-122.16, 37.16],
      [-122.15, 37.17],
      [-122.16, 37.16],
    ],
  },
  startAccessPoint: {
    id: "trailhead-a",
    name: "Fixture Trailhead",
    lon: -122.16,
    lat: 37.16,
    accessState: "public",
    confidence: "high",
  },
  endAccessPoint: {
    id: "trailhead-a",
    name: "Fixture Trailhead",
    lon: -122.16,
    lat: 37.16,
    accessState: "public",
    confidence: "high",
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
  source: {
    freshness: "2026-08-04T00:00:00Z",
    confidence: "high",
    sourceIds: ["fixture-source"],
  },
};

const COMPLETE_RESPONSE: GenerateRoutesResponseV1 = {
  version: 1,
  requestId: "request-fixture",
  pack: PACK_METADATA,
  requested: 2,
  exact: [ROUTE, { ...ROUTE, id: "loop_fixture_alternative" }],
  nearMisses: [],
  diagnostics: {
    elapsedMs: 12,
    expandedStates: 42,
    candidateCount: 4,
    exhausted: false,
    truncationReasons: [],
  },
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

  async getInducedGraph(): Promise<InducedGraph> {
    return { nodes: new Map(), edges: [], accessPoints: [] };
  }

  async getAccessPoints(): Promise<[]> {
    return [];
  }
}

function testPack(overrides: Partial<RoutePack> = {}): RoutePack {
  return {
    ...PACK_METADATA,
    coverageBbox: [-123, 37, -122, 38],
    maximumAreaSquareKilometers: 100,
    loadRepository: async () => new TestRepository(),
    ...overrides,
  };
}

function staticSolver(response: GenerateRoutesResponseV1 = COMPLETE_RESPONSE): RouteSolver {
  return { generate: vi.fn(async () => structuredClone(response)) };
}

function handlerFor(
  solver: RouteSolver = staticSolver(),
  pack: RoutePack = testPack(),
  budget: SolverBudget = TEST_BUDGET,
) {
  return createGenerateRoutesHandler({
    packs: new Map([[pack.id, pack]]),
    solver,
    budget,
  });
}

function jsonRequest(
  body: unknown = VALID_REQUEST,
  options: { signal?: AbortSignal; raw?: boolean } = {},
): Request {
  return new Request("http://localhost/api/routes/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: options.raw ? String(body) : JSON.stringify(body),
    signal: options.signal,
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { error: { code: string } };
  return body.error.code;
}

describe("POST /api/routes/generate request validation", () => {
  it("rejects malformed JSON with a structured 400", async () => {
    const response = await handlerFor()(jsonRequest("{", { raw: true }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("MALFORMED_JSON");
  });

  it("uses the existing strict request schema", async () => {
    const response = await handlerFor()(jsonRequest({ ...VALID_REQUEST, unexpected: true }));

    expect(response.status).toBe(400);
    const body = await response.json() as {
      error: { code: string; details: { issues: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.details.issues).toContainEqual(expect.objectContaining({ path: "" }));
  });

  it("rejects a degenerate rectangle before loading a pack", async () => {
    const loadRepository = vi.fn(async () => new TestRepository());
    const response = await handlerFor(staticSolver(), testPack({ loadRepository }))(
      jsonRequest({ ...VALID_REQUEST, bbox: [-122.16, 37.15, -122.16, 37.18] }),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("INVALID_REQUEST");
    expect(loadRepository).not.toHaveBeenCalled();
  });

  it("reports supported packs for an unknown pack", async () => {
    const response = await handlerFor()(
      jsonRequest({ ...VALID_REQUEST, packId: "not-installed" }),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as {
      error: { code: string; details: { supportedPackIds: string[] } };
    };
    expect(body.error.code).toBe("PACK_NOT_FOUND");
    expect(body.error.details.supportedPackIds).toEqual(["fixture-pack"]);
  });

  it("rejects a rectangle extending outside pack coverage", async () => {
    const response = await handlerFor(
      staticSolver(),
      testPack({ coverageBbox: [-122.17, 37.15, -122.13, 37.18] }),
    )(jsonRequest());

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("BOUNDARY_OUTSIDE_COVERAGE");
  });

  it("rejects an overlarge rectangle with its configured maximum", async () => {
    const response = await handlerFor(
      staticSolver(),
      testPack({ maximumAreaSquareKilometers: 1 }),
    )(jsonRequest());

    expect(response.status).toBe(422);
    const body = await response.json() as {
      error: { code: string; details: { areaSquareKilometers: number; maximumAreaSquareKilometers: number } };
    };
    expect(body.error.code).toBe("BOUNDARY_TOO_LARGE");
    expect(body.error.details.areaSquareKilometers).toBeGreaterThan(1);
    expect(body.error.details.maximumAreaSquareKilometers).toBe(1);
  });

  it("returns an actionable 503 when the local pack cannot be loaded", async () => {
    const pack = testPack({ loadRepository: async () => { throw new Error("missing fixture"); } });
    const response = await handlerFor(staticSolver(), pack)(jsonRequest());

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("PACK_UNAVAILABLE");
  });
});

describe("POST /api/routes/generate orchestration", () => {
  it("passes the repository, budget, and signal to the solver and closes the repository", async () => {
    const repository = new TestRepository();
    let repositorySignal: AbortSignal | undefined;
    const solver: RouteSolver = {
      generate: vi.fn(async (request, context) => {
        expect(request).toEqual(VALID_REQUEST);
        expect(context.repository).toBe(repository);
        expect(context.budget).toEqual(TEST_BUDGET);
        expect(context.signal?.aborted).toBe(false);
        expect(context.signal).toBe(repositorySignal);
        return structuredClone(COMPLETE_RESPONSE);
      }),
    };
    const response = await handlerFor(
      solver,
      testPack({
        loadRepository: async (signal) => {
          repositorySignal = signal;
          return repository;
        },
      }),
    )(jsonRequest());

    expect(response.status).toBe(200);
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it("returns deterministic validated output", async () => {
    const post = handlerFor();
    const first = await post(jsonRequest());
    const second = await post(jsonRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(COMPLETE_RESPONSE);
    expect(await second.json()).toEqual(COMPLETE_RESPONSE);
  });

  it("preserves diagnostics that explain fewer results", async () => {
    const partial: GenerateRoutesResponseV1 = {
      ...COMPLETE_RESPONSE,
      exact: [ROUTE],
      diagnostics: {
        elapsedMs: 19,
        expandedStates: 57,
        candidateCount: 1,
        exhausted: false,
        truncationReasons: ["fewer-diverse-routes-than-requested"],
      },
    };
    const response = await handlerFor(staticSolver(partial))(jsonRequest());

    expect(response.status).toBe(200);
    const body = await response.json() as GenerateRoutesResponseV1;
    expect(body.exact).toHaveLength(1);
    expect(body.diagnostics).toEqual(partial.diagnostics);
  });

  it("rejects an unexplained short or out-of-bound solver response", async () => {
    const unexplained: GenerateRoutesResponseV1 = {
      ...COMPLETE_RESPONSE,
      exact: [{
        ...ROUTE,
        geometry: { type: "LineString", coordinates: [[-122.16, 37.16], [-122, 37.16]] },
      }],
    };
    const response = await handlerFor(staticSolver(unexplained))(jsonRequest());

    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("INVALID_SOLVER_RESPONSE");
  });

  it("propagates client cancellation to the solver", async () => {
    const abortController = new AbortController();
    let solverSignal: AbortSignal | undefined;
    let markSolverStarted!: () => void;
    const solverStarted = new Promise<void>((resolve) => {
      markSolverStarted = resolve;
    });
    const solver: RouteSolver = {
      generate: vi.fn(async (_request, context) => {
        solverSignal = context.signal;
        markSolverStarted();
        return await new Promise<GenerateRoutesResponseV1>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      }),
    };
    const responsePromise = handlerFor(solver)(jsonRequest(VALID_REQUEST, { signal: abortController.signal }));
    await solverStarted;
    abortController.abort(new DOMException("cancelled", "AbortError"));
    const response = await responsePromise;

    expect(response.status).toBe(499);
    expect(await errorCode(response)).toBe("REQUEST_CANCELLED");
    expect(solverSignal?.aborted).toBe(true);
  });

  it("enforces a hard deadline through the solver signal", async () => {
    const solver: RouteSolver = {
      generate: vi.fn(async (_request, context) =>
        await new Promise<GenerateRoutesResponseV1>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        })),
    };
    const response = await handlerFor(solver, testPack(), { ...TEST_BUDGET, deadlineMs: 5 })(jsonRequest());

    expect(response.status).toBe(504);
    const body = await response.json() as {
      error: { code: string; details: { deadlineMs: number } };
    };
    expect(body.error.code).toBe("DEADLINE_EXCEEDED");
    expect(body.error.details.deadlineMs).toBe(5);
  });
});
