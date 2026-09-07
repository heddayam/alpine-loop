import type { RouteSearchRequest } from "./types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteGraphRepository, SQLiteClosedRouteFeasibilityRepository } from "@/lib/graph";
import { GRAPH_FIXTURE_IDENTITY, writeGraphFixture } from "@/lib/graph/test-helpers";

import {
  generatedClosedRouteV3Schema,
} from "@/lib/contracts";
import type {
  AccessPointCandidate,
  GraphEdge,
  GraphNode,
  InducedGraph,
} from "@/lib/graph";

import { RouteSearchCancelledError } from "./control";
import {
  ReachableGraphClosedRouteSolver,
  type ReachableGraphClosedRouteContext,
} from "./reachable-graph-closed-route-solver";

const PACK = GRAPH_FIXTURE_IDENTITY;
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
    sourceIds: ["fixture"],
    nearbyBuildingCount: 0,
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

const fixtures: Array<{ directory: string; repository: SQLiteGraphRepository; topology: SQLiteClosedRouteFeasibilityRepository }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.repository.close();
    await fixture.topology.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function request(overrides: Partial<RouteSearchRequest> = {}): RouteSearchRequest {
  return {
    closedRoute: { maximumRepeatedTrailPct: 100, allowMultiCycle: true },
    distanceMiles: { min: 0.92, max: 0.94 },
    includeUncertainAccess: false,
    searchEffort: "thorough",
    limit: 10,
    ...overrides,
  };
}

function context(
  points: AccessPointCandidate[],
  graph: InducedGraph,
  overrides: Partial<ReachableGraphClosedRouteContext> = {},
): ReachableGraphClosedRouteContext {
  const directory = mkdtempSync(join(tmpdir(), "solver-graph-"));
  const databasePath = join(directory, "pack.sqlite");
  const manifest = writeGraphFixture(databasePath, graph, points);
  const repository = new SQLiteGraphRepository(databasePath, manifest.id);
  const topology = new SQLiteClosedRouteFeasibilityRepository({ databasePath, manifest });
  fixtures.push({ directory, repository, topology });
  return {
    repository,
    topologyRepository: topology,
    budget: {
      maximumDirectedEdges: 1_000,
      maximumExpandedStates: 20_000,
      deadlineMs: 10_000,
      maximumRawCandidates: 2_000,
    },
    now: () => 0,
    accessFilter: {
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
    const zero = await solver.generate(
      request({ closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true }, limit: 1 }),
      context([point], fixtureGraph("loop")),
    );
    expect(zero.exact[0]?.topology).toMatchObject({ kind: "simple-loop", repeatedTrailFraction: 0 });

    for (const maximumRepeatedTrailPct of [25, 100]) {
      const result = await solver.generate(
        request({
          closedRoute: { maximumRepeatedTrailPct, allowMultiCycle: true },
          distanceMiles: { min: 1.17, max: 1.19 },
          limit: 1,
        }),
        context([point], fixtureGraph("lollipop")),
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
      context([point], fixtureGraph("lollipop")),
    );
    expect(repeatedZero.diagnostics.feasibleAccessPointCount).toBe(0);
    const stemCapped = await solver.generate(
      request({
        closedRoute: { maximumRepeatedTrailPct: 100, maximumSharedStemMiles: 0.1, allowMultiCycle: true },
        distanceMiles: { min: 1.17, max: 1.19 },
      }),
      context([point], fixtureGraph("lollipop")),
    );
    expect(stemCapped.diagnostics.feasibleAccessPointCount).toBe(0);
  });

  test("uses the multi-cycle toggle and labels a distance close match", async () => {
    const point = accessPoint();
    const figureEight = fixtureGraph("figure-eight");
    const target = request({ distanceMiles: { min: 1.85, max: 1.88 }, limit: 2 });
    const enabled = await solver.generate(target, context([point], figureEight));
    expect(enabled.exact.some(({ topology: value }) => value.cycleCount === 2)).toBe(true);

    const disabled = await solver.generate(
      { ...target, closedRoute: { ...target.closedRoute, allowMultiCycle: false } },
      context([point], figureEight),
    );
    expect([...disabled.exact, ...disabled.nearMisses].every(({ topology: value }) => value.cycleCount === 1)).toBe(true);

    const near = await solver.generate(
      request({ distanceMiles: { min: 0.95, max: 1 }, limit: 1 }),
      context([point], fixtureGraph("loop")),
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
      context([point], fixtureGraph("loop")),
    );

    expect(result.exact).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({
      steepestSustainedGradePct: 2,
      violations: [expect.objectContaining({ constraint: "steepest-sustained-grade", value: 2 })],
    });

    const elevation = await solver.generate(
      request({ maximumElevationFeet: { min: 0, max: 250 }, limit: 1 }),
      context([point], fixtureGraph("loop")),
    );
    expect(elevation.exact).toEqual([]);
    expect(elevation.nearMisses[0]?.violations).toEqual([
      expect.objectContaining({ constraint: "maximum-elevation" }),
    ]);
  });

  test("cheaply evaluates and fairly probes every eligible start without a top-N cutoff", async () => {
    const points = Array.from({ length: 12 }, (_, index) => ({ ...accessPoint(index), nodeId: `start-${index}` }));
    const graph: InducedGraph = { nodes: new Map(), edges: [], accessPoints: [] };
    // Distinct attachments exercise fair probing without bypassing real connector grouping.
    points.forEach((_, index) => {
      const loop = fixtureGraph("loop");
      for (const [id, node] of loop.nodes) graph.nodes.set(`${id}-${index}`, { ...node, id: `${id}-${index}` });
      graph.edges.push(...loop.edges.map((edge) => ({ ...edge, id: `${edge.id}-${index}`,
        fromNodeId: `${edge.fromNodeId}-${index}`, toNodeId: `${edge.toNodeId}-${index}`,
        physicalEdgeKey: edge.physicalEdgeKey! + index * 10 })));
    });
    const testContext = context(points, graph);
    const lookup = vi.spyOn(testContext.topologyRepository, "getAccessTopology");
    const result = await solver.generate(request({ searchEffort: "quick" }), testContext);

    expect(lookup).toHaveBeenCalledWith("known", points.map(({ id }) => id).sort());
    expect(result.diagnostics).toMatchObject({
      eligibleAccessPointCount: 12,
      feasibleAccessPointCount: 12,
      searchedAccessPointCount: 12,
      graphQueryCount: 12,
      probedAttachmentGroupCount: 12,
    });
    expect(result.exact.length).toBeGreaterThan(0);
    for (const route of result.exact) expect(generatedClosedRouteV3Schema.safeParse(route).success).toBe(true);
  });

  test("prepares eligible starts once for repeated Quick and Thorough searches", async () => {
    const points = [accessPoint(0), accessPoint(1), accessPoint(2)];
    const outside = { ...accessPoint(3), nodeId: "outside", lon: 2 };
    const allPoints = [...points, outside];
    const graph = fixtureGraph("loop");
    graph.nodes.set("outside", { id: "outside", lon: 2, lat: 0, elevationMeters: 100, flags: [] });
    const preparedContext = context(allPoints, graph);
    const enumerate = vi.spyOn(preparedContext.repository, "getAccessPointCandidates");
    const lookup = vi.spyOn(preparedContext.topologyRepository, "getAccessTopology");
    const target = request();
    const prepared = await solver.prepare(target, preparedContext);

    expect(prepared.eligibleAccessPointIds).toEqual(points.map(({ id }) => id));
    for (const startAccessPointId of prepared.eligibleAccessPointIds) {
      for (const searchEffort of ["quick", "thorough"] as const) {
        const policy = { startAccessPointId, searchEffort, limit: target.limit };
        const result = await prepared.generate(policy, preparedContext.budget);
        const ordinary = await solver.generate({ ...target, ...policy }, context(allPoints, graph));
        expect(result).toEqual(ordinary);
        expect(result.exact.length).toBeGreaterThan(0);
        expect(result.exact.every(({ startAccessPoint }) => startAccessPoint.id === startAccessPointId)).toBe(true);
      }
    }
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("known", points.map(({ id }) => id));
    await expect(prepared.generate({ searchEffort: "quick", limit: 1, startAccessPointId: outside.id }, preparedContext.budget))
      .rejects.toThrow("not prepared for this search");
  });

  test("filters automatic and explicit starts that sit among buildings", async () => {
    const builtUp = accessPoint();
    builtUp.nearbyBuildingCount = 500;
    const testContext = context([builtUp], fixtureGraph("loop"));
    const lookup = vi.spyOn(testContext.topologyRepository, "getAccessTopology");
    const result = await solver.generate(request(), testContext);
    expect(result.diagnostics).toMatchObject({
      eligibleAccessPointCount: 0,
      feasibleAccessPointCount: 0,
      searchedAccessPointCount: 0,
    });
    expect(lookup).toHaveBeenCalledWith("known", []);

    await expect(solver.generate(
      request({ startAccessPointId: builtUp.id }),
      context([builtUp], fixtureGraph("loop")),
    )).rejects.toThrow("excluded by the access-point area settings");
  });

  test("is deterministic and honors cancellation and the global deadline", async () => {
    const point = accessPoint();
    const first = await solver.generate(
      request({ limit: 1 }),
      context([point], fixtureGraph("loop")),
    );
    const second = await solver.generate(
      request({ limit: 1 }),
      context([point], fixtureGraph("loop")),
    );
    expect(first).toEqual(second);

    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await expect(solver.generate(
      request(),
      context(
        [point],
        fixtureGraph("loop"),
        { signal: controller.signal },
      ),
    )).rejects.toBeInstanceOf(RouteSearchCancelledError);

    let clock = 0;
    const deadlineContext = context(
      [point],
      fixtureGraph("loop"),
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
    expect(deadline.diagnostics.hardTruncationReasons).toContain("deadline");
    expect(deadline.diagnostics.graphQueryCount).toBe(0);
  });
});
