import { describe, expect, test } from "vitest";

import { generateClosedRoutesResponseV3Schema, type GenerateClosedRoutesRequestV3 } from "@/lib/contracts";
import type {
  AccessPointCandidate,
  AccessTopology,
  ClosedRouteTopologyRepository,
  CycleNetworkSummary,
  DecisionNetwork,
  GraphRepository,
  ReconstructedDirectedEdge,
  TopologyDecisionEdge,
} from "@/lib/graph";

import { createClosedRouteSolver } from "./closed-route-solver";
import { DeterministicClosedRoutePrimitiveCatalog } from "./primitive-catalog";

const positionByNode = new Map<string, [number, number]>([
  ["s", [0, 0]], ["a", [0.001, 0.001]], ["b", [0.002, 0]],
  ["c", [-0.001, 0.001]], ["d", [-0.002, 0]], ["h", [-0.001, 0]],
]);

function decisionEdge(
  id: number,
  from: number,
  to: number,
  physicalEdgeKey: number,
  blockId: number | null,
  lengthMeters = 100,
): TopologyDecisionEdge {
  return {
    id,
    fromDecisionNodeId: from,
    toDecisionNodeId: to,
    lengthMeters,
    gainMeters: 10,
    lossMeters: 5,
    maximumElevationMeters: 100,
    maximumSustainedGradePct: 5,
    accessState: "public",
    trailNames: ["Fixture Trail"],
    sourceIds: ["fixture"],
    flags: [],
    isBridge: blockId === null,
    twoEdgeComponentId: blockId ?? 0,
    vertexBlockId: blockId,
    members: [{ sequenceIndex: 0, edgeKey: id, physicalEdgeKey }],
  };
}

function fixtureNetwork(options: { stem?: boolean; figureEight?: boolean } = {}): DecisionNetwork {
  const offset = options.stem ? 1 : 0;
  const cycleOne = [
    decisionEdge(1, 1 + offset, 2 + offset, 1, 1),
    decisionEdge(2, 2 + offset, 3 + offset, 2, 1),
    decisionEdge(3, 3 + offset, 1 + offset, 3, 1),
    decisionEdge(4, 2 + offset, 1 + offset, 1, 1),
    decisionEdge(5, 3 + offset, 2 + offset, 2, 1),
    decisionEdge(6, 1 + offset, 3 + offset, 3, 1),
  ];
  const cycleTwo = options.figureEight ? [
    decisionEdge(7, 1 + offset, 4 + offset, 4, 2),
    decisionEdge(8, 4 + offset, 5 + offset, 5, 2),
    decisionEdge(9, 5 + offset, 1 + offset, 6, 2),
    decisionEdge(10, 4 + offset, 1 + offset, 4, 2),
    decisionEdge(11, 5 + offset, 4 + offset, 5, 2),
    decisionEdge(12, 1 + offset, 5 + offset, 6, 2),
  ] : [];
  const stem = options.stem ? [
    decisionEdge(20, 1, 2, 20, null),
    decisionEdge(21, 2, 1, 20, null),
  ] : [];
  const edges = [...cycleOne, ...cycleTwo, ...stem];
  const sourceNodes = options.stem
    ? [[1, "s"], [2, "h"], [3, "a"], [4, "b"], [5, "c"], [6, "d"]] as const
    : [[1, "s"], [2, "a"], [3, "b"], [4, "c"], [5, "d"]] as const;
  const blocks = [{
    id: 1,
    kind: "vertex-cycle" as const,
    decisionNodeIds: [1 + offset, 2 + offset, 3 + offset],
    decisionEdgeIds: cycleOne.map(({ id }) => id),
    cycleRank: 1,
    totalPhysicalLengthMeters: 300,
    minimumCycleLengthMeters: 300,
    minimumElevationMeters: 0,
    maximumElevationMeters: 100,
    trailNames: ["Fixture Trail"],
  }];
  if (options.figureEight) blocks.push({
    id: 2,
    kind: "vertex-cycle",
    decisionNodeIds: [1 + offset, 4 + offset, 5 + offset],
    decisionEdgeIds: cycleTwo.map(({ id }) => id),
    cycleRank: 1,
    totalPhysicalLengthMeters: 300,
    minimumCycleLengthMeters: 300,
    minimumElevationMeters: 0,
    maximumElevationMeters: 100,
    trailNames: ["Fixture Trail"],
  });
  return {
    profile: "known",
    networkId: 1,
    nodes: new Map(sourceNodes.map(([id, sourceNodeId]) => [id, {
      id,
      sourceNodeId,
      connectedComponentId: 1,
      twoEdgeComponentId: 1,
      isArticulation: Boolean(options.figureEight && id === 1 + offset),
      vertexBlockIds: options.figureEight && id === 1 + offset ? [1, 2] : [1],
    }])),
    edges,
    blocks,
    blockLinks: [],
    estimatedByteSize: 2_000,
    contentHash: `fixture-${Number(options.stem)}-${Number(options.figureEight)}`,
  };
}

function accessPoint(index: number, nodeId = "s"): AccessPointCandidate {
  const [lon, lat] = positionByNode.get(nodeId)!;
  return {
    id: `access-${index.toString().padStart(2, "0")}`,
    nodeId,
    name: `Access ${index}`,
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: "fixture",
    sourceIds: ["fixture"],
    lon,
    lat,
    knownConnectivity: 10,
    inclusiveConnectivity: 10,
    knownOutDegree: 2,
    inclusiveOutDegree: 2,
  };
}

function reconstructed(edge: TopologyDecisionEdge, network: DecisionNetwork): ReconstructedDirectedEdge {
  const from = network.nodes.get(edge.fromDecisionNodeId)!.sourceNodeId;
  const to = network.nodes.get(edge.toDecisionNodeId)!.sourceNodeId;
  return {
    id: `edge-${edge.id}`,
    edgeKey: edge.id,
    physicalEdgeKey: edge.members[0]!.physicalEdgeKey,
    stablePhysicalEdgeId: `physical-${edge.members[0]!.physicalEdgeKey}`,
    minimumElevationMeters: 0,
    fromNodeId: from,
    toNodeId: to,
    coordinates: [positionByNode.get(from)!, positionByNode.get(to)!],
    lengthMeters: edge.lengthMeters,
    gainMeters: edge.gainMeters,
    lossMeters: edge.lossMeters,
    maximumElevationMeters: edge.maximumElevationMeters,
    maximumSustainedGradePct: edge.maximumSustainedGradePct,
    accessState: edge.accessState,
    trailName: edge.trailNames[0] ?? null,
    sourceIds: [...edge.sourceIds],
    flags: [...edge.flags],
  };
}

class FixtureTopologyRepository implements ClosedRouteTopologyRepository {
  readonly packId = "fixture-pack";
  readonly dataVersion = "fixture-v3";
  readonly calls = { access: [] as string[][], networkLoads: 0, reconstructions: 0 };

  constructor(
    readonly network: DecisionNetwork,
    readonly topologies: ReadonlyMap<string, AccessTopology>,
    readonly rejectCompressedEdgeId?: number,
  ) {}

  async getAccessTopology(_profile: "known" | "inclusive", accessPointIds: readonly string[]) {
    this.calls.access.push([...accessPointIds]);
    return accessPointIds.map((id) => this.topologies.get(id)).filter((value): value is AccessTopology => Boolean(value));
  }

  async getNetworkSummary(profile: "known" | "inclusive", networkId: number): Promise<CycleNetworkSummary> {
    return {
      profile,
      networkId,
      decisionNodeCount: this.network.nodes.size,
      decisionEdgeCount: this.network.edges.length,
      cycleBlockCount: this.network.blocks.length,
      minimumCycleLengthMeters: 300,
      maximumCycleLengthMeters: 600,
      minimumElevationMeters: 0,
      maximumElevationMeters: 100,
    };
  }

  async loadDecisionNetwork(profile: "known" | "inclusive") {
    this.calls.networkLoads += 1;
    return { ...this.network, profile };
  }

  async reconstructDirectedEdges(compressedEdgeIds: readonly number[]) {
    this.calls.reconstructions += 1;
    if (this.rejectCompressedEdgeId !== undefined && compressedEdgeIds.includes(this.rejectCompressedEdgeId)) {
      throw new Error("directed reconstruction rejected");
    }
    const edgeById = new Map(this.network.edges.map((edge) => [edge.id, edge]));
    return compressedEdgeIds.map((id) => reconstructed(edgeById.get(id)!, this.network));
  }

  getCacheDiagnostics() {
    return { hits: 0, misses: 0, concurrentLoadJoins: 0, loads: 0, loadedBytes: 0, residentBytes: 0, evictions: 0 };
  }

  invalidate() {}
  async close() {}
}

function graphRepository(accessPoints: AccessPointCandidate[]): GraphRepository {
  return {
    packId: "fixture-pack",
    async getAccessPointCandidates() { return accessPoints; },
    async getInducedGraph() { throw new Error("raw graph must not be queried"); },
    async getAccessPoints() { throw new Error("raw graph must not be queried"); },
    async getReachableGraph() { throw new Error("raw graph must not be queried"); },
    async close() {},
  };
}

function topologyFor(point: AccessPointCandidate, options: { stem?: boolean; canReachCycle?: boolean; connectorKey?: string } = {}): AccessTopology {
  return {
    profile: "known",
    accessPointId: point.id,
    attachmentDecisionNodeId: 1,
    cycleNetworkId: options.canReachCycle === false ? null : 1,
    connectorKey: options.connectorKey ?? point.id,
    connectorDecisionEdgeIds: options.stem ? [20] : [],
    portalDecisionNodeId: options.canReachCycle === false ? null : options.stem ? 2 : 1,
    minimumStemDistanceMeters: options.canReachCycle === false ? null : options.stem ? 100 : 0,
    canReachCycle: options.canReachCycle ?? true,
  };
}

function request(overrides: Partial<GenerateClosedRoutesRequestV3> = {}): GenerateClosedRoutesRequestV3 {
  return {
    version: 3,
    packId: "fixture-pack",
    accessFilter: { mode: "drawn-area", bbox: [-1, -1, 1, 1] },
    routeFamily: "closed",
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 0.18, max: 0.2 },
    includeUncertainAccess: false,
    searchEffort: "thorough",
    limit: 10,
    ...overrides,
  };
}

function context(
  points: AccessPointCandidate[],
  topologyRepository: FixtureTopologyRepository,
  now: () => number = () => 0,
) {
  return {
    repository: graphRepository(points),
    topologyRepository,
    primitiveCatalog: new DeterministicClosedRoutePrimitiveCatalog({ dataVersion: "fixture-v3" }),
    budget: { maximumDirectedEdges: 1_000, maximumExpandedStates: 10_000, deadlineMs: 10_000, maximumRawCandidates: 1_000 },
    now,
    accessFilter: {
      summary: { mode: "drawn-area" as const, label: "Fixture area" },
      predicates: [{ type: "Polygon" as const, coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] }],
      coverage: { type: "Polygon" as const, coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] },
    },
  };
}

const solver = createClosedRouteSolver({
  pack: { id: "fixture-pack", schemaVersion: "3", dataVersion: "fixture-v3", builtAt: "2026-01-01T00:00:00.000Z" },
});

describe("TopologyFirstClosedRouteSolver", () => {
  test("safely prunes no-cycle starts and shallow-probes every group without an eight-start cutoff", async () => {
    const points = Array.from({ length: 12 }, (_, index) => accessPoint(index));
    const topologies = new Map(points.map((point) => [point.id, topologyFor(point)]));
    topologies.set(points[11]!.id, topologyFor(points[11]!, { canReachCycle: false }));
    const repository = new FixtureTopologyRepository(fixtureNetwork(), topologies);
    const result = await solver.generate(request(), context(points, repository));

    expect(repository.calls.access[0]).toHaveLength(12);
    expect(result.diagnostics).toMatchObject({
      eligibleAccessPointCount: 12,
      noCycleAccessPointCount: 1,
      feasibleAccessPointCount: 11,
      attachmentGroupCount: 11,
      probedAttachmentGroupCount: 11,
      deeplySearchedAttachmentGroupCount: 11,
      loadedTopologyNetworkCount: 1,
      searchedAccessPointCount: 11,
    });
    expect(result.diagnostics.candidateCount).toBeGreaterThanOrEqual(11);
    expect(repository.calls.networkLoads).toBe(1);
    expect(result.exact).toHaveLength(1);
    expect(generateClosedRoutesResponseV3Schema.safeParse(result).success).toBe(true);
  });

  test("retains an exact selected start and is deterministic apart from a pinned clock", async () => {
    const points = [accessPoint(1), accessPoint(2)];
    const topologies = new Map(points.map((point) => [point.id, topologyFor(point)]));
    const selectedRequest = request({ startAccessPointId: points[1]!.id, limit: 1 });
    const firstRepository = new FixtureTopologyRepository(fixtureNetwork(), topologies);
    const secondRepository = new FixtureTopologyRepository(fixtureNetwork(), topologies);
    const first = await solver.generate(selectedRequest, context(points, firstRepository));
    const second = await solver.generate(selectedRequest, context(points, secondRepository));

    expect(first).toEqual(second);
    expect(first.exact[0]?.startAccessPoint.id).toBe(points[1]!.id);
  });

  test("applies 0/35/100 repetition and shared-stem caps independently of lollipop classification", async () => {
    const point = accessPoint(1);
    const topologies = new Map([[point.id, topologyFor(point, { stem: true })]]);
    const network = fixtureNetwork({ stem: true });

    for (const maximumRepeatedTrailPct of [35, 100]) {
      const result = await solver.generate(
        request({
          closedRoute: { maximumRepeatedTrailPct, allowMultiCycle: true },
          distanceMiles: { min: 0.3, max: 0.32 },
          limit: 1,
        }),
        context([point], new FixtureTopologyRepository(network, topologies)),
      );
      expect(result.exact[0]?.topology).toMatchObject({
        kind: "lollipop",
        repeatedTrailDistanceMeters: 100,
        repeatedTrailFraction: 0.2,
        sharedStemDistanceMeters: 100,
      });
    }

    const zero = await solver.generate(
      request({ closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true } }),
      context([point], new FixtureTopologyRepository(network, topologies)),
    );
    expect(zero.diagnostics.feasibleAccessPointCount).toBe(0);
    const stemCapped = await solver.generate(
      request({ closedRoute: { maximumRepeatedTrailPct: 100, maximumSharedStemMiles: 0.01, allowMultiCycle: true } }),
      context([point], new FixtureTopologyRepository(network, topologies)),
    );
    expect(stemCapped.diagnostics.feasibleAccessPointCount).toBe(0);
  });

  test("insertion repair contributes an exact multi-cycle result and the toggle excludes it", async () => {
    const point = accessPoint(1);
    const topologies = new Map([[point.id, topologyFor(point)]]);
    const network = fixtureNetwork({ figureEight: true });
    const target = request({ distanceMiles: { min: 0.36, max: 0.39 }, limit: 2 });
    const enabled = await solver.generate(target, context([point], new FixtureTopologyRepository(network, topologies)));
    expect(enabled.diagnostics.repairedCandidateCount).toBeGreaterThan(0);
    expect(enabled.exact.some(({ topology }) => topology.kind === "figure-eight" && topology.cycleCount === 2)).toBe(true);
    expect(enabled.nearMisses.every(({ violations }) => violations.length > 0)).toBe(true);

    const disabled = await solver.generate(
      { ...target, closedRoute: { ...target.closedRoute, allowMultiCycle: false } },
      context([point], new FixtureTopologyRepository(network, topologies)),
    );
    expect([...disabled.exact, ...disabled.nearMisses].every(({ topology }) => topology.cycleCount === 1)).toBe(true);
  });

  test("counts directed reconstruction rejection, enforces budgets, and propagates cancellation", async () => {
    const point = accessPoint(1);
    const topologies = new Map([[point.id, topologyFor(point)]]);
    const network = fixtureNetwork();
    const rejected = await solver.generate(
      request(),
      context([point], new FixtureTopologyRepository(network, topologies, 1)),
    );
    expect(rejected.diagnostics.directedValidationRejectionCount).toBeGreaterThan(0);
    expect(rejected.exact).toEqual([]);

    const budgetContext = context([point], new FixtureTopologyRepository(network, topologies));
    budgetContext.budget.maximumRawCandidates = 1;
    const bounded = await solver.generate(request(), budgetContext);
    expect(bounded.diagnostics.hardTruncationReasons).toContain("maximum-raw-candidates");
    expect(bounded.diagnostics.deeplySearchedAttachmentGroupCount).toBe(0);

    const abort = new AbortController();
    abort.abort("cancelled fixture");
    await expect(solver.generate(request(), { ...context([point], new FixtureTopologyRepository(network, topologies)), signal: abort.signal }))
      .rejects.toThrow("Route generation was cancelled");
  });
});
