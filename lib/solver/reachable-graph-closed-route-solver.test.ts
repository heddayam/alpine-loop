import { describe, expect, test } from "vitest";

import {
  generateClosedRoutesResponseV3Schema,
  type GenerateClosedRoutesRequestV3,
} from "@/lib/contracts";
import type {
  AccessPointCandidate,
  AccessTopology,
  GraphEdge,
  GraphNode,
  GraphRepository,
  InducedGraph,
} from "@/lib/graph";

import { RouteSearchCancelledError } from "./control";
import {
  ReachableGraphClosedRouteSolver,
  type ClosedRouteFeasibilityRepository,
  type ReachableGraphClosedRouteContext,
} from "./reachable-graph-closed-route-solver";

const PACK = {
  id: "fixture-pack",
  schemaVersion: "3" as const,
  dataVersion: "fixture-v3",
  builtAt: "2026-01-01T00:00:00.000Z",
};
const AREA = {
  type: "Polygon" as const,
  coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
};

type GraphKind = "loop" | "lollipop" | "figure-eight";

function accessPoint(index = 0): AccessPointCandidate {
  return {
    id: `access-${index}`,
    nodeId: "start",
    name: `Access ${index}`,
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: "fixture",
    populationWithinRadius: null,
    localReliefM: null,
    sourceIds: ["fixture"],
    lon: 0,
    lat: 0,
    knownConnectivity: 10,
    inclusiveConnectivity: 10,
    knownOutDegree: 2,
    inclusiveOutDegree: 2,
  };
}

function fixtureGraph(kind: GraphKind): InducedGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (id: string, lon: number, lat: number): void => {
    nodes.set(id, { id, lon, lat, elevationMeters: 100, flags: [] });
  };
  const addDirected = (from: string, to: string, lengthMeters: number, physicalEdgeKey: number): void => {
    const fromNode = nodes.get(from)!;
    const toNode = nodes.get(to)!;
    edges.push({
      id: `${from}->${to}`,
      edgeKey: edges.length + 1,
      fromNodeId: from,
      toNodeId: to,
      coordinates: [[fromNode.lon, fromNode.lat], [toNode.lon, toNode.lat]],
      lengthMeters,
      gainMeters: 0,
      lossMeters: 0,
      maximumElevationMeters: 100,
      maximumSustainedGradePct: 2,
      accessState: "public",
      trailName: `Trail ${physicalEdgeKey}`,
      sourceIds: ["fixture"],
      flags: [],
      physicalEdgeKey,
    });
  };
  const addBidirectional = (from: string, to: string, lengthMeters: number, key: number): void => {
    addDirected(from, to, lengthMeters, key);
    addDirected(to, from, lengthMeters, key);
  };
  addNode("start", 0, 0);
  if (kind === "loop") {
    addNode("a", 0.001, 0);
    addNode("b", 0.001, 0.001);
    addBidirectional("start", "a", 500, 1);
    addBidirectional("a", "b", 500, 2);
    addBidirectional("b", "start", 500, 3);
  } else {
    const hub = kind === "lollipop" ? "hub" : "start";
    if (kind === "lollipop") {
      addNode("hub", 0.0002, 0);
      addBidirectional("start", "hub", 200, 1);
    }
    addNode("a", 0.001, 0);
    addNode("b", 0.001, 0.001);
    addBidirectional(hub, "a", 500, 2);
    addBidirectional("a", "b", 500, 3);
    addBidirectional("b", hub, 500, 4);
    if (kind === "figure-eight") {
      addNode("c", -0.001, 0);
      addNode("d", -0.001, -0.001);
      addBidirectional("start", "c", 500, 5);
      addBidirectional("c", "d", 500, 6);
      addBidirectional("d", "start", 500, 7);
    }
  }
  return { nodes, edges, accessPoints: [] };
}

class FixtureGraphRepository implements GraphRepository {
  readonly packId = PACK.id;
  readonly queriedStarts: string[] = [];

  constructor(
    private readonly points: AccessPointCandidate[],
    private readonly graph: InducedGraph,
  ) {}

  async getAccessPointCandidates() { return this.points; }
  async getReachableGraph(query: Parameters<GraphRepository["getReachableGraph"]>[0]) {
    if (query.signal?.aborted) throw query.signal.reason;
    this.queriedStarts.push(query.startNodeId);
    return { graph: this.graph, truncated: false };
  }
  async getInducedGraph() { return this.graph; }
  async getAccessPoints() { return []; }
  async close() {}
}

class FixtureFeasibilityRepository implements ClosedRouteFeasibilityRepository {
  readonly packId = PACK.id;
  readonly dataVersion = PACK.dataVersion;
  readonly requestedIds: string[][] = [];

  constructor(
    private readonly points: AccessPointCandidate[],
    private readonly stemMeters: number,
    private readonly canReachCycle = true,
  ) {}

  async getAccessTopology(profile: "known" | "inclusive", accessPointIds: readonly string[]) {
    this.requestedIds.push([...accessPointIds]);
    return this.points.filter(({ id }) => accessPointIds.includes(id)).map((point): AccessTopology => ({
      profile,
      accessPointId: point.id,
      attachmentDecisionNodeId: 1,
      cycleNetworkId: this.canReachCycle ? 1 : null,
      connectorKey: `connector-${point.id}`,
      connectorDecisionEdgeIds: [],
      portalDecisionNodeId: this.canReachCycle ? 1 : null,
      minimumStemDistanceMeters: this.canReachCycle ? this.stemMeters : null,
      canReachCycle: this.canReachCycle,
    }));
  }
}

function request(overrides: Partial<GenerateClosedRoutesRequestV3> = {}): GenerateClosedRoutesRequestV3 {
  return {
    version: 3,
    packId: PACK.id,
    accessFilter: { mode: "drawn-area", bbox: [-1, -1, 1, 1] },
    routeFamily: "closed",
    closedRoute: { maximumRepeatedTrailPct: 100, allowMultiCycle: true },
    distanceMiles: { min: 0.92, max: 0.94 },
    includeUncertainAccess: false,
    accessPointRemoteness: ["remote", "rural", "populated", "unknown"],
    searchEffort: "thorough",
    limit: 10,
    ...overrides,
  };
}

function context(
  points: AccessPointCandidate[],
  graph: InducedGraph,
  topology: FixtureFeasibilityRepository,
  overrides: Partial<ReachableGraphClosedRouteContext> = {},
): ReachableGraphClosedRouteContext {
  return {
    repository: new FixtureGraphRepository(points, graph),
    topologyRepository: topology,
    budget: {
      maximumDirectedEdges: 1_000,
      maximumExpandedStates: 20_000,
      deadlineMs: 10_000,
      maximumRawCandidates: 2_000,
    },
    now: () => 0,
    accessFilter: {
      summary: { mode: "drawn-area", label: "Fixture area" },
      predicates: [AREA],
      coverage: AREA,
    },
    ...overrides,
  };
}

const solver = new ReachableGraphClosedRouteSolver({ pack: PACK });

describe("ReachableGraphClosedRouteSolver", () => {
  test("applies 0/25/100 repetition and the shared-stem cap using exact physical edges", async () => {
    const point = accessPoint();
    const loopTopology = new FixtureFeasibilityRepository([point], 0);
    const zero = await solver.generate(
      request({ closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true }, limit: 1 }),
      context([point], fixtureGraph("loop"), loopTopology),
    );
    expect(zero.exact[0]?.topology).toMatchObject({ kind: "simple-loop", repeatedTrailFraction: 0 });

    for (const maximumRepeatedTrailPct of [25, 100]) {
      const topology = new FixtureFeasibilityRepository([point], 200);
      const result = await solver.generate(
        request({
          closedRoute: { maximumRepeatedTrailPct, allowMultiCycle: true },
          distanceMiles: { min: 1.17, max: 1.19 },
          limit: 1,
        }),
        context([point], fixtureGraph("lollipop"), topology),
      );
      expect(result.exact[0]?.topology).toMatchObject({
        kind: "lollipop",
        repeatedTrailDistanceMeters: 200,
        sharedStemDistanceMeters: 200,
      });
    }

    const repeatedZero = await solver.generate(
      request({
        closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true },
        distanceMiles: { min: 1.17, max: 1.19 },
      }),
      context([point], fixtureGraph("lollipop"), new FixtureFeasibilityRepository([point], 200)),
    );
    expect(repeatedZero.diagnostics.feasibleAccessPointCount).toBe(0);
    const stemCapped = await solver.generate(
      request({
        closedRoute: { maximumRepeatedTrailPct: 100, maximumSharedStemMiles: 0.1, allowMultiCycle: true },
        distanceMiles: { min: 1.17, max: 1.19 },
      }),
      context([point], fixtureGraph("lollipop"), new FixtureFeasibilityRepository([point], 200)),
    );
    expect(stemCapped.diagnostics.feasibleAccessPointCount).toBe(0);
  });

  test("uses the multi-cycle toggle and labels a distance near miss", async () => {
    const point = accessPoint();
    const figureEight = fixtureGraph("figure-eight");
    const topology = new FixtureFeasibilityRepository([point], 0);
    const target = request({ distanceMiles: { min: 1.85, max: 1.88 }, limit: 2 });
    const enabled = await solver.generate(target, context([point], figureEight, topology));
    expect(enabled.exact.some(({ topology: value }) => value.cycleCount === 2)).toBe(true);

    const disabled = await solver.generate(
      { ...target, closedRoute: { ...target.closedRoute, allowMultiCycle: false } },
      context([point], figureEight, new FixtureFeasibilityRepository([point], 0)),
    );
    expect([...disabled.exact, ...disabled.nearMisses].every(({ topology: value }) => value.cycleCount === 1)).toBe(true);

    const near = await solver.generate(
      request({ distanceMiles: { min: 0.95, max: 1 }, limit: 1 }),
      context([point], fixtureGraph("loop"), new FixtureFeasibilityRepository([point], 0)),
    );
    expect(near.exact).toEqual([]);
    expect(near.nearMisses[0]?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ constraint: "distance" }),
    ]));
  });

  test("applies sustained-grade ranges after route reconstruction", async () => {
    const point = accessPoint();
    const result = await solver.generate(
      request({ steepestSustainedGradePct: { min: 0, max: 1 }, limit: 1 }),
      context([point], fixtureGraph("loop"), new FixtureFeasibilityRepository([point], 0)),
    );

    expect(result.exact).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({
      steepestSustainedGradePct: 2,
      violations: [expect.objectContaining({ constraint: "steepest-sustained-grade", value: 2 })],
    });
  });

  test("cheaply evaluates and fairly probes every eligible start without a top-N cutoff", async () => {
    const points = Array.from({ length: 12 }, (_, index) => accessPoint(index));
    const topology = new FixtureFeasibilityRepository(points, 0);
    const testContext = context(points, fixtureGraph("loop"), topology);
    const result = await solver.generate(request({ searchEffort: "quick" }), testContext);

    expect(topology.requestedIds).toEqual([points.map(({ id }) => id).sort()]);
    expect(result.diagnostics).toMatchObject({
      eligibleAccessPointCount: 12,
      feasibleAccessPointCount: 12,
      searchedAccessPointCount: 12,
      graphQueryCount: 12,
      probedAttachmentGroupCount: 12,
      loadedTopologyNetworkCount: 0,
    });
    expect(generateClosedRoutesResponseV3Schema.safeParse(result).success).toBe(true);
  });

  test("filters automatic and explicit starts by access-point area type", async () => {
    const populated = accessPoint();
    populated.populationWithinRadius = 5_000;
    const topology = new FixtureFeasibilityRepository([populated], 0);
    const result = await solver.generate(
      request({ accessPointRemoteness: ["remote"] }),
      context([populated], fixtureGraph("loop"), topology),
    );
    expect(result.diagnostics).toMatchObject({
      eligibleAccessPointCount: 0,
      feasibleAccessPointCount: 0,
      searchedAccessPointCount: 0,
    });
    expect(topology.requestedIds).toEqual([[]]);

    await expect(solver.generate(
      request({ startAccessPointId: populated.id, accessPointRemoteness: ["remote"] }),
      context([populated], fixtureGraph("loop"), new FixtureFeasibilityRepository([populated], 0)),
    )).rejects.toThrow("excluded by the access-point area settings");
  });

  test("is deterministic and honors cancellation and the global deadline", async () => {
    const point = accessPoint();
    const first = await solver.generate(
      request({ limit: 1 }),
      context([point], fixtureGraph("loop"), new FixtureFeasibilityRepository([point], 0)),
    );
    const second = await solver.generate(
      request({ limit: 1 }),
      context([point], fixtureGraph("loop"), new FixtureFeasibilityRepository([point], 0)),
    );
    expect(first).toEqual(second);

    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await expect(solver.generate(
      request(),
      context(
        [point],
        fixtureGraph("loop"),
        new FixtureFeasibilityRepository([point], 0),
        { signal: controller.signal },
      ),
    )).rejects.toBeInstanceOf(RouteSearchCancelledError);

    let clock = 0;
    const deadlineContext = context(
      [point],
      fixtureGraph("loop"),
      new FixtureFeasibilityRepository([point], 0),
      {
        now: () => clock++,
        budget: {
          maximumDirectedEdges: 1_000,
          maximumExpandedStates: 20_000,
          deadlineMs: 1,
          maximumRawCandidates: 2_000,
        },
      },
    );
    const deadline = await solver.generate(request(), deadlineContext);
    expect(deadline.diagnostics.exhausted).toBe(true);
    expect(deadline.diagnostics.hardTruncationReasons).toContain("deadline");
    expect(deadline.diagnostics.graphQueryCount).toBe(0);
  });
});
