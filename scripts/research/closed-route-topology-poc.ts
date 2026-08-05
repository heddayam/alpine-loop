import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { packManifestV2Schema, type GenerateRoutesRequestV2 } from "@/lib/contracts";
import {
  areaBounds,
  SQLiteGraphRepository,
  type AccessPointCandidate,
  type AreaGeometry,
} from "@/lib/graph";
import {
  compareScoredCandidates,
  createMultiStartRouteSolver,
  DEFAULT_SOLVER_BUDGET,
  generateInitialCandidates,
  scoreCandidate,
  type ScoredCandidate,
  undirectedDistanceOverlap,
} from "@/lib/solver";

const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;
const DEFAULT_STARTS = [
  "osm-access-way-419983545",
  "osm-access-node-314138178",
  "osm-access-node-1423689504",
  "osm-access-node-9096651304",
  "osm-access-way-26662597",
];

type SqliteValue = string | number | bigint | null;
type SqliteRow = Record<string, SqliteValue>;

type PhysicalGraph = {
  nodeIds: string[];
  nodeIndex: Map<string, number>;
  edgeU: number[];
  edgeV: number[];
  edgeLength: number[];
  directedRows: number;
  bidirectionalEdges: number;
  oneWayEdges: number;
  degreeNotTwoNodes: number;
  offsets: Int32Array;
  adjacentEdges: Int32Array;
};

type TopologyIndex = {
  bridges: Uint8Array;
  componentByNode: Int32Array;
  componentCount: number;
  cyclicComponents: Uint8Array;
  cyclicComponentCount: number;
  nearestCycleComponent: Int32Array;
  stemDistanceMeters: Float64Array;
};

type AccessTopologySummary = {
  eligibleAccessPoints: number;
  attachedAccessPoints: number;
  exactAttachmentNodes: number;
  reachableCyclePortals: number;
  accessPointsReachingCycle: number;
  accessPointsWithoutCycle: number;
  feasibleWithinFiveMileStem: number;
  feasibleCyclePortals: number;
  largestPortalCohorts: Array<{ portal: number; accessPoints: number }>;
};

class MinHeap {
  readonly #components: number[] = [];
  readonly #distances: number[] = [];

  get size(): number {
    return this.#components.length;
  }

  push(component: number, distance: number): void {
    let index = this.#components.length;
    this.#components.push(component);
    this.#distances.push(distance);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#distances[parent]! <= distance) break;
      this.#components[index] = this.#components[parent]!;
      this.#distances[index] = this.#distances[parent]!;
      index = parent;
    }
    this.#components[index] = component;
    this.#distances[index] = distance;
  }

  pop(): { component: number; distance: number } | undefined {
    if (this.#components.length === 0) return undefined;
    const component = this.#components[0]!;
    const distance = this.#distances[0]!;
    const lastComponent = this.#components.pop()!;
    const lastDistance = this.#distances.pop()!;
    if (this.#components.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.#components.length) break;
        const right = left + 1;
        const child = right < this.#components.length
          && this.#distances[right]! < this.#distances[left]!
          ? right
          : left;
        if (this.#distances[child]! >= lastDistance) break;
        this.#components[index] = this.#components[child]!;
        this.#distances[index] = this.#distances[child]!;
        index = child;
      }
      this.#components[index] = lastComponent;
      this.#distances[index] = lastDistance;
    }
    return { component, distance };
  }
}

function argument(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requiredString(row: SqliteRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

function requiredNumber(row: SqliteRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number") throw new Error(`Expected ${name} to be a number`);
  return value;
}

function physicalEdgeId(directedEdgeId: string): string {
  return directedEdgeId.replace(/:(?:forward|reverse)$/, "");
}

function loadPhysicalGraph(database: DatabaseSync): PhysicalGraph {
  const nodeIds: string[] = [];
  const nodeIndex = new Map<string, number>();
  const edgeU: number[] = [];
  const edgeV: number[] = [];
  const edgeLength: number[] = [];
  const directionCounts: number[] = [];
  const physicalIndex = new Map<string, number>();
  let directedRows = 0;

  const indexFor = (nodeId: string): number => {
    const existing = nodeIndex.get(nodeId);
    if (existing !== undefined) return existing;
    const next = nodeIds.length;
    nodeIds.push(nodeId);
    nodeIndex.set(nodeId, next);
    return next;
  };

  const rows = database.prepare(
    `SELECT id, from_node, to_node, length_m
     FROM edges
     WHERE access_state IN ('public', 'unknown')
     ORDER BY id`,
  ).iterate() as Iterable<SqliteRow>;
  for (const row of rows) {
    directedRows += 1;
    const id = physicalEdgeId(requiredString(row, "id"));
    const existing = physicalIndex.get(id);
    if (existing !== undefined) {
      directionCounts[existing] = (directionCounts[existing] ?? 1) + 1;
      continue;
    }
    const edgeIndex = edgeU.length;
    physicalIndex.set(id, edgeIndex);
    edgeU.push(indexFor(requiredString(row, "from_node")));
    edgeV.push(indexFor(requiredString(row, "to_node")));
    edgeLength.push(requiredNumber(row, "length_m"));
    directionCounts.push(1);
  }

  const degree = new Int32Array(nodeIds.length);
  for (let edge = 0; edge < edgeU.length; edge += 1) {
    degree[edgeU[edge]!] += 1;
    degree[edgeV[edge]!] += 1;
  }
  const offsets = new Int32Array(nodeIds.length + 1);
  for (let node = 0; node < nodeIds.length; node += 1) {
    offsets[node + 1] = offsets[node]! + degree[node]!;
  }
  const adjacentEdges = new Int32Array(offsets[nodeIds.length]!);
  const cursor = offsets.slice(0, nodeIds.length);
  for (let edge = 0; edge < edgeU.length; edge += 1) {
    adjacentEdges[cursor[edgeU[edge]!]!++] = edge;
    adjacentEdges[cursor[edgeV[edge]!]!++] = edge;
  }

  return {
    nodeIds,
    nodeIndex,
    edgeU,
    edgeV,
    edgeLength,
    directedRows,
    bidirectionalEdges: directionCounts.filter((count) => count >= 2).length,
    oneWayEdges: directionCounts.filter((count) => count === 1).length,
    degreeNotTwoNodes: [...degree].filter((value) => value !== 2).length,
    offsets,
    adjacentEdges,
  };
}

function buildTopologyIndex(graph: PhysicalGraph): TopologyIndex {
  const nodeCount = graph.nodeIds.length;
  const discovery = new Int32Array(nodeCount);
  const low = new Int32Array(nodeCount);
  const parentNode = new Int32Array(nodeCount);
  const parentEdge = new Int32Array(nodeCount);
  const nextAdjacent = new Int32Array(nodeCount);
  const childCount = new Int32Array(nodeCount);
  const bridges = new Uint8Array(graph.edgeU.length);
  parentNode.fill(-1);
  parentEdge.fill(-1);
  let clock = 0;

  for (let root = 0; root < nodeCount; root += 1) {
    if (discovery[root] !== 0) continue;
    const stack = [root];
    while (stack.length > 0) {
      const node = stack[stack.length - 1]!;
      if (discovery[node] === 0) {
        clock += 1;
        discovery[node] = clock;
        low[node] = clock;
        nextAdjacent[node] = graph.offsets[node]!;
      }
      if (nextAdjacent[node]! < graph.offsets[node + 1]!) {
        const edge = graph.adjacentEdges[nextAdjacent[node]!]!;
        nextAdjacent[node] += 1;
        if (edge === parentEdge[node]) continue;
        const adjacent = graph.edgeU[edge] === node ? graph.edgeV[edge]! : graph.edgeU[edge]!;
        if (discovery[adjacent] === 0) {
          parentNode[adjacent] = node;
          parentEdge[adjacent] = edge;
          childCount[node] += 1;
          stack.push(adjacent);
        } else {
          low[node] = Math.min(low[node]!, discovery[adjacent]!);
        }
        continue;
      }
      stack.pop();
      const parent = parentNode[node]!;
      if (parent >= 0) {
        low[parent] = Math.min(low[parent]!, low[node]!);
        if (low[node]! > discovery[parent]!) bridges[parentEdge[node]!] = 1;
      }
    }
  }

  const componentByNode = new Int32Array(nodeCount);
  componentByNode.fill(-1);
  const componentNodeCounts: number[] = [];
  const componentEdgeCounts: number[] = [];
  let componentCount = 0;
  for (let seed = 0; seed < nodeCount; seed += 1) {
    if (componentByNode[seed] !== -1) continue;
    const pending = [seed];
    componentByNode[seed] = componentCount;
    let nodes = 0;
    let twiceEdges = 0;
    while (pending.length > 0) {
      const node = pending.pop()!;
      nodes += 1;
      for (let cursor = graph.offsets[node]!; cursor < graph.offsets[node + 1]!; cursor += 1) {
        const edge = graph.adjacentEdges[cursor]!;
        if (bridges[edge]) continue;
        twiceEdges += 1;
        const adjacent = graph.edgeU[edge] === node ? graph.edgeV[edge]! : graph.edgeU[edge]!;
        if (componentByNode[adjacent] === -1) {
          componentByNode[adjacent] = componentCount;
          pending.push(adjacent);
        }
      }
    }
    componentNodeCounts.push(nodes);
    componentEdgeCounts.push(twiceEdges / 2);
    componentCount += 1;
  }

  const cyclicComponents = new Uint8Array(componentCount);
  let cyclicComponentCount = 0;
  for (let component = 0; component < componentCount; component += 1) {
    if (componentEdgeCounts[component]! - componentNodeCounts[component]! + 1 > 0) {
      cyclicComponents[component] = 1;
      cyclicComponentCount += 1;
    }
  }

  const treeAdjacency: Array<Array<{ component: number; length: number }>> = Array.from(
    { length: componentCount },
    () => [],
  );
  for (let edge = 0; edge < graph.edgeU.length; edge += 1) {
    if (!bridges[edge]) continue;
    const left = componentByNode[graph.edgeU[edge]!]!;
    const right = componentByNode[graph.edgeV[edge]!]!;
    if (left === right) continue;
    const length = graph.edgeLength[edge]!;
    treeAdjacency[left]!.push({ component: right, length });
    treeAdjacency[right]!.push({ component: left, length });
  }

  const nearestCycleComponent = new Int32Array(componentCount);
  nearestCycleComponent.fill(-1);
  const stemDistanceMeters = new Float64Array(componentCount);
  stemDistanceMeters.fill(Number.POSITIVE_INFINITY);
  const heap = new MinHeap();
  for (let component = 0; component < componentCount; component += 1) {
    if (!cyclicComponents[component]) continue;
    nearestCycleComponent[component] = component;
    stemDistanceMeters[component] = 0;
    heap.push(component, 0);
  }
  while (heap.size > 0) {
    const current = heap.pop()!;
    if (current.distance !== stemDistanceMeters[current.component]) continue;
    for (const adjacent of treeAdjacency[current.component]!) {
      const nextDistance = current.distance + adjacent.length;
      if (nextDistance >= stemDistanceMeters[adjacent.component]!) continue;
      stemDistanceMeters[adjacent.component] = nextDistance;
      nearestCycleComponent[adjacent.component] = nearestCycleComponent[current.component]!;
      heap.push(adjacent.component, nextDistance);
    }
  }

  return {
    bridges,
    componentByNode,
    componentCount,
    cyclicComponents,
    cyclicComponentCount,
    nearestCycleComponent,
    stemDistanceMeters,
  };
}

function summarizeAccessTopology(
  database: DatabaseSync,
  graph: PhysicalGraph,
  topology: TopologyIndex,
): AccessTopologySummary {
  const rows = database.prepare(
    `SELECT access_points.id, access_points.node_id
     FROM access_points
     WHERE access_points.access_state IN ('public', 'unknown')
     ORDER BY access_points.id`,
  ).all() as SqliteRow[];
  const attachmentNodes = new Set<number>();
  const allPortalCounts = new Map<number, number>();
  const feasiblePortalCounts = new Map<number, number>();
  let attachedAccessPoints = 0;
  let accessPointsReachingCycle = 0;
  let feasibleWithinFiveMileStem = 0;
  for (const row of rows) {
    const node = graph.nodeIndex.get(requiredString(row, "node_id"));
    if (node === undefined) continue;
    attachedAccessPoints += 1;
    attachmentNodes.add(node);
    const component = topology.componentByNode[node]!;
    const portal = topology.nearestCycleComponent[component]!;
    if (portal < 0) continue;
    accessPointsReachingCycle += 1;
    allPortalCounts.set(portal, (allPortalCounts.get(portal) ?? 0) + 1);
    if (topology.stemDistanceMeters[component]! <= 5 * METERS_PER_MILE) {
      feasibleWithinFiveMileStem += 1;
      feasiblePortalCounts.set(portal, (feasiblePortalCounts.get(portal) ?? 0) + 1);
    }
  }
  return {
    eligibleAccessPoints: rows.length,
    attachedAccessPoints,
    exactAttachmentNodes: attachmentNodes.size,
    reachableCyclePortals: allPortalCounts.size,
    accessPointsReachingCycle,
    accessPointsWithoutCycle: rows.length - accessPointsReachingCycle,
    feasibleWithinFiveMileStem,
    feasibleCyclePortals: feasiblePortalCounts.size,
    largestPortalCohorts: [...feasiblePortalCounts]
      .map(([portal, accessPoints]) => ({ portal, accessPoints }))
      .sort((left, right) => right.accessPoints - left.accessPoints || left.portal - right.portal)
      .slice(0, 10),
  };
}

function v2Request(packId: string, startAccessPointId: string): GenerateRoutesRequestV2 {
  return {
    version: 2,
    packId,
    accessFilter: { mode: "named-region", regionId: `pack:${packId}` },
    startAccessPointId,
    routeTypes: ["loop", "lollipop"],
    pointToPoint: { finishMustMatchAccessFilter: true },
    distanceMiles: { min: 6, max: 10 },
    elevationGainFeet: { min: 1_500, max: 2_500 },
    includeUncertainAccess: true,
    limit: 10,
  };
}

function selectDiverseExact(candidates: readonly ScoredCandidate[]): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.every((other) => undirectedDistanceOverlap(candidate, other) <= 0.8)) selected.push(candidate);
  }
  return selected;
}

function v1Request(
  packId: string,
  startAccessPointId: string,
  bbox: readonly [number, number, number, number],
) {
  return {
    version: 1 as const,
    packId,
    bbox: [...bbox] as [number, number, number, number],
    startAccessPointId,
    routeTypes: ["loop", "lollipop"] as Array<"loop" | "lollipop">,
    distanceMiles: { min: 6, max: 10 },
    elevationGainFeet: { min: 1_500, max: 2_500 },
    includeUncertainAccess: true,
    limit: 10,
  };
}

async function findStart(
  repository: SQLiteGraphRepository,
  coverage: AreaGeometry,
  startAccessPointId: string,
): Promise<AccessPointCandidate> {
  const candidates = await repository.getAccessPointCandidates({
    bbox: areaBounds(coverage),
    includeUncertainAccess: true,
  });
  const start = candidates.find(({ id }) => id === startAccessPointId);
  if (!start) throw new Error(`Missing start access point ${startAccessPointId}`);
  return start;
}

async function benchmarkStart(options: {
  databasePath: string;
  coverage: AreaGeometry;
  pack: { id: string; schemaVersion: string; dataVersion: string; builtAt: string };
  startAccessPointId: string;
}) {
  const baselineRepository = new SQLiteGraphRepository(options.databasePath, options.pack.id);
  let baseline;
  try {
    const solver = createMultiStartRouteSolver({ pack: options.pack });
    const started = performance.now();
    const response = await solver.generate(v2Request(options.pack.id, options.startAccessPointId), {
      repository: baselineRepository,
      accessFilter: {
        summary: { mode: "named-region", label: "Full pack POC" },
        predicates: [options.coverage],
        coverage: options.coverage,
      },
      budget: DEFAULT_SOLVER_BUDGET,
    });
    baseline = {
      elapsedMs: performance.now() - started,
      exactReturned: response.exact.length,
      exactShapes: response.exact.map(({ shape }) => shape),
      diagnostics: response.diagnostics,
    };
  } finally {
    await baselineRepository.close();
  }

  const unifiedRepository = new SQLiteGraphRepository(options.databasePath, options.pack.id);
  try {
    const totalStarted = performance.now();
    const start = await findStart(unifiedRepository, options.coverage, options.startAccessPointId);
    const graphStarted = performance.now();
    const reachable = await unifiedRepository.getReachableGraph({
      startNodeId: start.nodeId,
      maximumDistanceMeters: 10 * METERS_PER_MILE * 1.25,
      maximumDirectedEdges: DEFAULT_SOLVER_BUDGET.maximumDirectedEdges,
      includeUncertainAccess: true,
      coverage: options.coverage,
    });
    const graphLoadMs = performance.now() - graphStarted;
    const generationStarted = performance.now();
    const generation = generateInitialCandidates(
      reachable.graph,
      v1Request(options.pack.id, options.startAccessPointId, areaBounds(options.coverage)),
      {
        budget: {
          ...DEFAULT_SOLVER_BUDGET,
          deadlineMs: DEFAULT_SOLVER_BUDGET.deadlineMs - 750,
        },
      },
    );
    const generationMs = performance.now() - generationStarted;
    const scored = generation.candidates.map((candidate) => scoreCandidate(
      candidate,
      v1Request(options.pack.id, options.startAccessPointId, areaBounds(options.coverage)),
    ));
    const exact = scored.filter(({ exact }) => exact).sort(compareScoredCandidates);
    const diverseExact = selectDiverseExact(exact);
    return {
      startAccessPointId: options.startAccessPointId,
      startName: start.name,
      baselineSplitLanes: baseline,
      unifiedClosedLane: {
        elapsedMs: performance.now() - totalStarted,
        graphLoadMs,
        generationMs,
        graphDirectedEdges: reachable.graph.edges.length,
        graphTruncated: reachable.truncated,
        rawCandidates: scored.length,
        exactCandidates: exact.length,
        diverseExactCandidates: diverseExact.length,
        exactShapes: [...new Set(exact.map(({ shape }) => shape))].sort(),
        bestExact: diverseExact
          .slice(0, 3)
          .map((candidate) => ({
            shape: candidate.shape,
            distanceMiles: candidate.metrics.distanceMeters / METERS_PER_MILE,
            elevationGainFeet: candidate.metrics.elevationGainMeters / METERS_PER_FOOT,
            repeatedFraction: candidate.metrics.repeatedEdgeFraction,
          })),
        diagnostics: generation.diagnostics,
      },
    };
  } finally {
    await unifiedRepository.close();
  }
}

async function main(): Promise<void> {
  const databasePath = path.resolve(argument("--database")
    ?? ".local-data/packs/santa-cruz-mountains/scm-a339bce45af76f29/pack.sqlite");
  const manifestPath = path.resolve(argument("--manifest")
    ?? path.join(path.dirname(databasePath), "manifest.json"));
  const starts = argument("--starts")?.split(",").filter(Boolean) ?? DEFAULT_STARTS;
  const manifest = packManifestV2Schema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const memoryBefore = process.memoryUsage().rss;
  const topologyStarted = performance.now();
  const physicalGraph = loadPhysicalGraph(database);
  const graphLoadMs = performance.now() - topologyStarted;
  const decompositionStarted = performance.now();
  const topology = buildTopologyIndex(physicalGraph);
  const decompositionMs = performance.now() - decompositionStarted;
  const accessSummary = summarizeAccessTopology(database, physicalGraph, topology);
  database.close();
  const memoryAfter = process.memoryUsage().rss;

  const pack = {
    id: manifest.id,
    schemaVersion: manifest.schemaVersion,
    dataVersion: manifest.dataVersion,
    builtAt: manifest.builtAt,
  };
  const benchmarks = [];
  for (const startAccessPointId of starts) {
    benchmarks.push(await benchmarkStart({
      databasePath,
      coverage: manifest.coverage.boundary,
      pack,
      startAccessPointId,
    }));
  }
  const baselineTotalMs = benchmarks.reduce(
    (sum, benchmark) => sum + benchmark.baselineSplitLanes.elapsedMs,
    0,
  );
  const unifiedTotalMs = benchmarks.reduce(
    (sum, benchmark) => sum + benchmark.unifiedClosedLane.elapsedMs,
    0,
  );

  process.stdout.write(`${JSON.stringify({
    experiment: "closed-route-topology-poc",
    pack,
    request: {
      routeTypes: ["loop", "lollipop"],
      distanceMiles: { min: 6, max: 10 },
      elevationGainFeet: { min: 1_500, max: 2_500 },
    },
    topology: {
      graphLoadMs,
      decompositionMs,
      rssGrowthMb: (memoryAfter - memoryBefore) / (1024 * 1024),
      directedRows: physicalGraph.directedRows,
      physicalEdges: physicalGraph.edgeU.length,
      graphNodes: physicalGraph.nodeIds.length,
      bidirectionalEdges: physicalGraph.bidirectionalEdges,
      oneWayEdges: physicalGraph.oneWayEdges,
      degreeNotTwoNodes: physicalGraph.degreeNotTwoNodes,
      bridges: topology.bridges.reduce((sum, bridge) => sum + bridge, 0),
      bridgeFreeComponents: topology.componentCount,
      cyclicComponents: topology.cyclicComponentCount,
      accessPoints: accessSummary,
    },
    benchmarks,
    aggregate: {
      starts: benchmarks.length,
      baselineTotalMs,
      unifiedTotalMs,
      unifiedWallTimeReductionPct: baselineTotalMs > 0
        ? (1 - unifiedTotalMs / baselineTotalMs) * 100
        : 0,
      baselineDiverseExactRoutes: benchmarks.reduce(
        (sum, benchmark) => sum + benchmark.baselineSplitLanes.exactReturned,
        0,
      ),
      unifiedDiverseExactRoutes: benchmarks.reduce(
        (sum, benchmark) => sum + benchmark.unifiedClosedLane.diverseExactCandidates,
        0,
      ),
    },
    interpretation: {
      topologyHypothesis: "validated when eligible trailheads collapse to materially fewer feasible cycle portals",
      unifiedLaneHypothesis: "validated when one closed-route lane improves exact yield or work under the same global budget",
      caveat: "This POC uses underlying undirected topology for grouping; every generated route still uses legal directed pack edges.",
    },
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
