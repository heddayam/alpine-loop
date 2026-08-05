import { describe, expect, it } from "vitest";
import tinyFixture from "@/data/fixtures/graph/solver-shapes.json";
import {
  generateRoutesResponseV2Schema,
  type GenerateRoutesRequestV2,
} from "@/lib/contracts";
import {
  coordinateIsInsideArea,
  FixtureGraphRepository,
  type AccessPointCandidate,
  type AreaGeometry,
  type FixtureGraphData,
  type GraphRepository,
  type ReachableGraphQuery,
} from "@/lib/graph";
import { DEFAULT_SOLVER_BUDGET } from "./budget";
import { AccessFilterResolutionError, createMultiStartRouteSolver } from "./multi-start-solver";

const PACK = {
  id: "fixture-pack",
  schemaVersion: "2",
  dataVersion: "fixture-v2",
  builtAt: "2026-08-04T00:00:00Z",
} as const;
const COVERAGE: AreaGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.19, 37.15], [-122.13, 37.15], [-122.13, 37.18],
    [-122.19, 37.18], [-122.19, 37.15],
  ]],
};
const DRAWN_AREA: AreaGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.161, 37.159], [-122.159, 37.159], [-122.159, 37.161],
    [-122.161, 37.161], [-122.161, 37.159],
  ]],
};

function request(overrides: Partial<GenerateRoutesRequestV2> = {}): GenerateRoutesRequestV2 {
  return {
    version: 2,
    packId: PACK.id,
    accessFilter: { mode: "drawn-area", bbox: [-122.161, 37.159, -122.159, 37.161] },
    routeTypes: ["out-and-back"],
    pointToPoint: { finishMustMatchAccessFilter: true },
    distanceMiles: { min: 0, max: 30 },
    includeUncertainAccess: true,
    limit: 10,
    ...overrides,
  };
}

function repository() {
  return new FixtureGraphRepository(tinyFixture as unknown as FixtureGraphData);
}

function context() {
  return {
    repository: repository(),
    budget: DEFAULT_SOLVER_BUDGET,
    now: () => Date.parse("2026-08-04T00:00:00Z"),
    accessFilter: {
      summary: { mode: "drawn-area" as const, label: "Drawn area" },
      predicates: [DRAWN_AREA],
      coverage: COVERAGE,
    },
  };
}

const solver = createMultiStartRouteSolver({ pack: PACK, sourceConfidence: "medium" });

describe("multi-start route solver", () => {
  it("filters starts without clipping hiking geometry", async () => {
    const response = await solver.generate(request(), context());

    expect(generateRoutesResponseV2Schema.parse(response)).toEqual(response);
    expect(response.exact.length).toBeGreaterThan(0);
    expect(response.diagnostics.eligibleAccessPointCount).toBe(1);
    expect(response.diagnostics.searchedAccessPointCount).toBe(1);
    expect(response.exact.every(({ filterMatch }) => filterMatch.start)).toBe(true);
    expect(response.exact.some(({ geometry }) => geometry.coordinates.some(
      (coordinate) => !coordinateIsInsideArea(coordinate as [number, number], DRAWN_AREA),
    ))).toBe(true);
  });

  it("returns a valid empty response when the filter contains no eligible start", async () => {
    const emptyArea: AreaGeometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    };
    const response = await solver.generate(request({
      accessFilter: { mode: "drawn-area", bbox: [0, 0, 1, 1] },
    }), {
      ...context(),
      accessFilter: { summary: { mode: "drawn-area", label: "Empty" }, predicates: [emptyArea], coverage: COVERAGE },
    });

    expect(response.exact).toEqual([]);
    expect(response.nearMisses).toEqual([]);
    expect(response.diagnostics.shortfallReasons).toContain("no-eligible-start-access-points");
  });

  it("distinguishes an unknown explicit start from one outside the filter", async () => {
    await expect(solver.generate(request({ startAccessPointId: "missing" }), context())).rejects.toMatchObject({
      code: "START_NOT_FOUND",
    } satisfies Partial<AccessFilterResolutionError>);
    await expect(solver.generate(request({ startAccessPointId: "trailhead-h" }), context())).rejects.toMatchObject({
      code: "START_OUTSIDE_FILTER",
    } satisfies Partial<AccessFilterResolutionError>);
  });

  it("applies the finish filter only when requested for point-to-point routes", async () => {
    const constrained = await solver.generate(request({
      routeTypes: ["point-to-point"],
      startAccessPointId: "trailhead-a",
      pointToPoint: { finishMustMatchAccessFilter: true },
      limit: 1,
    }), context());
    const unconstrained = await solver.generate(request({
      routeTypes: ["point-to-point"],
      startAccessPointId: "trailhead-a",
      pointToPoint: { finishMustMatchAccessFilter: false },
      limit: 1,
    }), context());

    expect(constrained.exact).toEqual([]);
    expect(unconstrained.exact[0]).toMatchObject({
      filterMatch: { start: true, end: false },
      warnings: expect.arrayContaining(["Finish is outside the trailhead filter"]),
    });
  });

  it("searches at most eight ranked starts and reserves the first graph share fairly", async () => {
    const base = repository();
    const graph = await base.getInducedGraph({
      bbox: [-122.19, 37.15, -122.13, 37.18],
      includeUncertainAccess: true,
    });
    const node = graph.nodes.get("a")!;
    const candidates: AccessPointCandidate[] = Array.from({ length: 9 }, (_, index) => ({
      id: `ranked-${index}`,
      nodeId: node.id,
      name: `Ranked ${index}`,
      kind: "trailhead",
      accessState: "public",
      confidence: "high",
      parkingEvidence: "fixture",
      sourceIds: ["fixture-source"],
      lon: node.lon,
      lat: node.lat,
      knownConnectivity: 100 - index,
      inclusiveConnectivity: 100 - index,
      knownOutDegree: 10,
      inclusiveOutDegree: 10,
    }));
    const maximumEdges: number[] = [];
    const tracking: GraphRepository = {
      packId: PACK.id,
      getInducedGraph: (query) => base.getInducedGraph(query),
      getAccessPoints: (bbox, include) => base.getAccessPoints(bbox, include),
      getAccessPointCandidates: async () => candidates,
      getReachableGraph: async (query: ReachableGraphQuery) => {
        maximumEdges.push(query.maximumDirectedEdges);
        const reachable = await base.getReachableGraph(query);
        return {
          ...reachable,
          graph: { ...reachable.graph, accessPoints: candidates },
        };
      },
      close: () => base.close(),
    };
    const response = await solver.generate(request({ limit: 1 }), {
      ...context(),
      repository: tracking,
    });

    expect(response.diagnostics.searchedAccessPointCount).toBe(8);
    expect(maximumEdges).toHaveLength(8);
    expect(maximumEdges[0]).toBe(DEFAULT_SOLVER_BUDGET.maximumDirectedEdges / 2);
    expect(maximumEdges.every((maximum) => maximum <= DEFAULT_SOLVER_BUDGET.maximumDirectedEdges / 2)).toBe(true);
  });

  it("does not let a giant uncertain urban component outrank known trail connectivity", async () => {
    const base = repository();
    const graph = await base.getInducedGraph({
      bbox: [-122.19, 37.15, -122.13, 37.18],
      includeUncertainAccess: true,
    });
    const urbanNode = graph.nodes.get("a")!;
    const mountainNode = graph.nodes.get("b")!;
    const candidate = (
      id: string,
      candidateNode: typeof urbanNode,
      knownConnectivity: number,
      inclusiveConnectivity: number,
    ): AccessPointCandidate => ({
      id,
      nodeId: candidateNode.id,
      name: id,
      kind: "trailhead",
      accessState: "public",
      confidence: "medium",
      parkingEvidence: "fixture",
      sourceIds: ["fixture-source"],
      lon: candidateNode.lon,
      lat: candidateNode.lat,
      knownConnectivity,
      inclusiveConnectivity,
      knownOutDegree: knownConnectivity > 0 ? 2 : 0,
      inclusiveOutDegree: 4,
    });
    const candidates = [
      candidate("urban-giant", urbanNode, 0, 1_000_000),
      candidate("mountain-network", mountainNode, 20_000, 30_000),
    ];
    const queriedStarts: string[] = [];
    const tracking: GraphRepository = {
      packId: PACK.id,
      getInducedGraph: (query) => base.getInducedGraph(query),
      getAccessPoints: (bbox, include) => base.getAccessPoints(bbox, include),
      getAccessPointCandidates: async () => candidates,
      getReachableGraph: async (query: ReachableGraphQuery) => {
        queriedStarts.push(query.startNodeId);
        const reachable = await base.getReachableGraph(query);
        return { ...reachable, graph: { ...reachable.graph, accessPoints: candidates } };
      },
      close: () => base.close(),
    };

    const baseContext = context();
    await solver.generate(request({ limit: 1 }), {
      ...baseContext,
      repository: tracking,
      accessFilter: { ...baseContext.accessFilter, predicates: [COVERAGE] },
    });

    expect(queriedStarts[0]).toBe(mountainNode.id);
  });
});
