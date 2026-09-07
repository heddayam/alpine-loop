import type { RouteSearchRequest } from "./types";
import { maximumSustainedGradePct, SUSTAINED_GRADE_WINDOW_M } from "@/lib/data/metrics";
import {
  edgeIsTraversable,
  type EdgeTraversal,
  type GraphAccessPoint,
  type InducedGraph,
} from "@/lib/graph";

import type { SolverBudget } from "./budget";
import { contractCorridors, physicalKeyOf } from "./contract-corridors";
import { stableHash } from "./route-identity";
import { RouteSearchCancelledError } from "./control";

const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;

export const PENALIZED_SEARCH_CAPS = Object.freeze({
  maximumRounds: 48,
  maximumAttemptsPerRound: 400,
  maximumStrictRounds: 24,
  maximumStrictAttempts: 600,
  maximumStrictReturnSearches: 12,
  maximumPivots: 8,
  maximumLollipopAttempts: 600,
  maximumLollipopReturnSearches: 10,
  maximumCompositionPool: 48,
  maximumAssemblyPairs: 2_000,
  maximumAssemblyOffers: 64,
  maximumRepairCandidates: 32,
  maximumRepairSpans: 200,
  maximumReserve: 64,
  maximumValidArchive: 256,
  maximumNearArchive: 64,
  maximumNearResults: 5,
});

export type PenalizedClosedRouteCandidate = {
  id: string;
  traversals: EdgeTraversal[];
  distanceMeters: number;
  elevationGainMeters: number;
  repeatedEdgeFraction: number;
  score: number;
  violatedConstraints: string[];
};

export type PenalizedClosedRouteSearchDiagnostics = {
  elapsedMs: number;
  expandedStates: number;
  candidateCount: number;
  validCandidateCount: number;
  repairAttempts: number;
  repairAccepted: number;
  assemblyAttempts: number;
  assemblyAccepted: number;
  exhausted: boolean;
  truncationReasons: string[];
};

export type PenalizedClosedRouteSearchResult = {
  candidates: PenalizedClosedRouteCandidate[];
  nearCandidates: PenalizedClosedRouteCandidate[];
  diagnostics: PenalizedClosedRouteSearchDiagnostics;
};

export type PenalizedClosedRouteSearchOptions = {
  budget: SolverBudget;
  signal?: AbortSignal;
  now?: () => number;
  maximumRouteOverlapFraction?: number;
};

type InternalGraph = {
  traversals: EdgeTraversal[][];
  nodeIds: string[];
  from: Int32Array;
  to: Int32Array;
  length: Float64Array;
  gain: Float64Array;
  maximumElevation: Float64Array;
  physical: string[];
  directed: string[];
  outgoing: number[][];
  incoming: number[][];
  reverse: Map<string, number>;
  start: number;
};

type Metrics = {
  distance: number;
  gain: number;
  maximumElevation: number;
  maximumGrade: number;
  repeated: number;
  repeatedFraction: number;
  cycleRank: number;
  physicalLengths: Map<string, number>;
};

type Candidate = {
  id: string;
  edges: number[];
  metrics: Metrics;
  score: number;
  violations: string[];
};

type SearchTree = {
  realLength: Float64Array;
  realGain: Float64Array;
  parent: Int32Array;
  settled: Uint8Array;
  source: number;
};

class MinHeap {
  readonly #distances: number[] = [];
  readonly #nodes: number[] = [];

  get size(): number {
    return this.#distances.length;
  }

  push(distance: number, node: number): void {
    this.#distances.push(distance);
    this.#nodes.push(node);
    let index = this.#distances.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.#before(index, parent)) break;
      this.#swap(index, parent);
      index = parent;
    }
  }

  pop(): { distance: number; node: number } {
    const distance = this.#distances[0]!;
    const node = this.#nodes[0]!;
    const lastDistance = this.#distances.pop()!;
    const lastNode = this.#nodes.pop()!;
    if (this.#distances.length > 0) {
      this.#distances[0] = lastDistance;
      this.#nodes[0] = lastNode;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < this.size && this.#before(left, next)) next = left;
        if (right < this.size && this.#before(right, next)) next = right;
        if (next === index) break;
        this.#swap(index, next);
        index = next;
      }
    }
    return { distance, node };
  }

  #before(left: number, right: number): boolean {
    return this.#distances[left]! < this.#distances[right]!
      || (this.#distances[left] === this.#distances[right] && this.#nodes[left]! < this.#nodes[right]!);
  }

  #swap(left: number, right: number): void {
    [this.#distances[left], this.#distances[right]] = [this.#distances[right]!, this.#distances[left]!];
    [this.#nodes[left], this.#nodes[right]] = [this.#nodes[right]!, this.#nodes[left]!];
  }
}

function buildGraph(
  graph: InducedGraph,
  startNodeId: string,
  includeUncertainAccess: boolean,
): InternalGraph {
  const originals: EdgeTraversal[] = [];
  for (const edge of graph.edges) {
    const from = graph.nodes.get(edge.fromNodeId);
    const to = graph.nodes.get(edge.toNodeId);
    if (from && to && edgeIsTraversable(edge, includeUncertainAccess)) originals.push({ edge, from, to });
  }
  originals.sort((left, right) => left.edge.id.localeCompare(right.edge.id)
    || left.from.id.localeCompare(right.from.id) || left.to.id.localeCompare(right.to.id));
  const traversals = contractCorridors(originals, startNodeId);
  const nodeIds = [...new Set(traversals.flatMap((chain) => [chain[0]!.from.id, chain.at(-1)!.to.id]))].sort();
  const nodeIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const from = new Int32Array(traversals.length);
  const to = new Int32Array(traversals.length);
  const length = new Float64Array(traversals.length);
  const gain = new Float64Array(traversals.length);
  const maximumElevation = new Float64Array(traversals.length).fill(Number.NEGATIVE_INFINITY);
  const physical: string[] = [];
  const directed: string[] = [];
  const outgoing = Array.from({ length: nodeIds.length }, () => [] as number[]);
  const incoming = Array.from({ length: nodeIds.length }, () => [] as number[]);
  const reverse = new Map<string, number>();
  for (const [index, chain] of traversals.entries()) {
    from[index] = nodeIndex.get(chain[0]!.from.id)!;
    to[index] = nodeIndex.get(chain.at(-1)!.to.id)!;
    const keys = chain.map(({ edge }) => physicalKeyOf(edge));
    const forwardKey = keys.join("|");
    const reverseKey = [...keys].reverse().join("|");
    physical[index] = forwardKey < reverseKey ? forwardKey : reverseKey;
    directed[index] = chain.map(({ edge }) => edge.edgeKey ?? edge.id).join(",");
    for (const { edge } of chain) {
      length[index] += edge.lengthMeters;
      gain[index] += edge.gainMeters;
      maximumElevation[index] = Math.max(maximumElevation[index]!, edge.maximumElevationMeters ?? Number.NEGATIVE_INFINITY);
    }
    outgoing[from[index]!]!.push(index);
    incoming[to[index]!]!.push(index);
    reverse.set(`${physical[index]}:${from[index]}:${to[index]}`, index);
  }
  return { traversals, nodeIds, from, to, length, gain, maximumElevation, physical, directed,
    outgoing, incoming, reverse, start: nodeIndex.get(startNodeId) ?? -1 };
}

function physicalOverlap(left: Metrics, right: Metrics): number {
  const [small, large] = left.physicalLengths.size <= right.physicalLengths.size
    ? [left.physicalLengths, right.physicalLengths]
    : [right.physicalLengths, left.physicalLengths];
  let shared = 0;
  for (const [key, value] of small) {
    const other = large.get(key);
    if (other !== undefined) shared += Math.min(value, other);
  }
  const leftDistance = [...left.physicalLengths.values()].reduce((sum, value) => sum + value, 0);
  const rightDistance = [...right.physicalLengths.values()].reduce((sum, value) => sum + value, 0);
  return shared / Math.max(1, Math.min(leftDistance, rightDistance));
}

export function searchPenalizedClosedRoutes(
  sourceGraph: InducedGraph,
  start: GraphAccessPoint | string,
  request: RouteSearchRequest,
  options: PenalizedClosedRouteSearchOptions,
): PenalizedClosedRouteSearchResult {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + options.budget.deadlineMs;
  if (options.signal?.aborted) throw new RouteSearchCancelledError(options.signal.reason);
  const graph = buildGraph(
    sourceGraph,
    typeof start === "string" ? start : start.nodeId,
    request.includeUncertainAccess,
  );
  const truncationReasons = new Set<string>();
  const penalties = new Map<string, number>();
  const seen = new Set<string>();
  const provisional: Candidate[] = [];
  const reserve: Candidate[] = [];
  const validArchive: Candidate[] = [];
  const nearBelow: Candidate[] = [];
  const nearAbove: Candidate[] = [];
  let expandedStates = 0;
  let candidateCount = 0;
  let validCandidateCount = 0;
  let repairAttempts = 0;
  let repairAccepted = 0;
  let assemblyAttempts = 0;
  let assemblyAccepted = 0;
  const minMeters = request.distanceMiles.min * METERS_PER_MILE;
  const maxMeters = request.distanceMiles.max * METERS_PER_MILE;
  const targetMeters = (minMeters + maxMeters) / 2;
  const maximumRepeatedFraction = request.closedRoute.maximumRepeatedTrailPct / 100;
  const maximumSharedStemMeters = request.closedRoute.maximumSharedStemMiles === undefined
    ? Number.POSITIVE_INFINITY
    : request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE;
  const overlapLimit = options.maximumRouteOverlapFraction ?? 0.8;

  if (graph.traversals.reduce((count, chain) => count + chain.length, 0) > options.budget.maximumDirectedEdges) {
    truncationReasons.add("maximum-directed-edges");
  }

  const checkCancellation = (): void => {
    if (options.signal?.aborted) throw new RouteSearchCancelledError(options.signal.reason);
  };
  const outOfTime = (): boolean => {
    checkCancellation();
    if (now() < deadlineAt) return false;
    truncationReasons.add("deadline");
    return true;
  };
  const exhausted = (stateCap = options.budget.maximumExpandedStates, candidateCap = options.budget.maximumRawCandidates): boolean => {
    if (expandedStates >= stateCap) truncationReasons.add("maximum-expanded-states");
    if (candidateCount >= candidateCap) truncationReasons.add("maximum-raw-candidates");
    return outOfTime() || expandedStates >= stateCap || candidateCount >= candidateCap;
  };

  const physicalBridges = (): Set<string> => {
    const first = new Map<string, { from: number; to: number }>();
    for (let edge = 0; edge < graph.traversals.length; edge += 1) {
      if ((edge & 1_023) === 0 && outOfTime()) return new Set();
      if (!first.has(graph.physical[edge]!)) {
        first.set(graph.physical[edge]!, { from: graph.from[edge]!, to: graph.to[edge]! });
      }
    }
    const adjacency = new Map<number, Array<{ node: number; key: string }>>();
    const add = (node: number, other: number, key: string): void => {
      const list = adjacency.get(node) ?? [];
      list.push({ node: other, key });
      adjacency.set(node, list);
    };
    for (const [key, edge] of first) {
      add(edge.from, edge.to, key);
      add(edge.to, edge.from, key);
    }
    const discovery = new Int32Array(graph.nodeIds.length).fill(-1);
    const low = new Int32Array(graph.nodeIds.length);
    const bridges = new Set<string>();
    let time = 0;
    for (const root of [...adjacency.keys()].sort((left, right) => left - right)) {
      if (discovery[root] !== -1) continue;
      const stack: Array<{ node: number; parentKey: string | null; index: number }> = [
        { node: root, parentKey: null, index: 0 },
      ];
      discovery[root] = ++time;
      low[root] = time;
      while (stack.length > 0) {
        if ((time & 1_023) === 0 && outOfTime()) return bridges;
        const frame = stack.at(-1)!;
        const neighbors = adjacency.get(frame.node) ?? [];
        if (frame.index < neighbors.length) {
          const adjacent = neighbors[frame.index++]!;
          if (adjacent.key === frame.parentKey) continue;
          if (discovery[adjacent.node] === -1) {
            discovery[adjacent.node] = ++time;
            low[adjacent.node] = time;
            stack.push({ node: adjacent.node, parentKey: adjacent.key, index: 0 });
          } else {
            low[frame.node] = Math.min(low[frame.node]!, discovery[adjacent.node]!);
          }
        } else {
          stack.pop();
          const parent = stack.at(-1);
          if (parent) {
            low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!);
            if (low[frame.node]! > discovery[parent.node]!) bridges.add(frame.parentKey!);
          }
        }
      }
    }
    return bridges;
  };

  let cachedBridges: Set<string> | undefined;
  const sharedStem = (edges: readonly number[]): number => {
    if (edges.length < 2) return 0;
    cachedBridges ??= physicalBridges();
    let distance = 0;
    for (let left = 0, right = edges.length - 1; left < right; left += 1, right -= 1) {
      const outward = edges[left]!;
      const inbound = edges[right]!;
      if (graph.physical[outward] !== graph.physical[inbound]
        || !cachedBridges.has(graph.physical[outward]!)) break;
      distance += Math.min(graph.length[outward]!, graph.length[inbound]!);
    }
    return distance;
  };

  const evaluate = (edges: readonly number[]): Metrics => {
    let distance = 0;
    let gain = 0;
    let maximumElevation = Number.NEGATIVE_INFINITY;
    let maximumGrade = 0;
    let repeated = 0;
    const physicalLengths = new Map<string, number>();
    const nodes = new Set([graph.start]);
    const elevationProfile = request.steepestSustainedGradePct
      ? [{ distanceMeters: 0, elevationMeters: sourceGraph.nodes.get(graph.nodeIds[graph.start]!)?.elevationMeters ?? Number.NaN }]
      : null;
    for (const edge of edges) {
      distance += graph.length[edge]!;
      gain += graph.gain[edge]!;
      maximumElevation = Math.max(maximumElevation, graph.maximumElevation[edge]!);
      if (elevationProfile) {
        let offset = distance - graph.length[edge]!;
        for (const traversal of graph.traversals[edge]!) {
          if (traversal.edge.lengthMeters >= SUSTAINED_GRADE_WINDOW_M) {
            maximumGrade = Math.max(maximumGrade, traversal.edge.maximumSustainedGradePct ?? 0);
          }
          offset += traversal.edge.lengthMeters;
          elevationProfile.push({ distanceMeters: offset, elevationMeters: traversal.to.elevationMeters ?? Number.NaN });
        }
      }
      if (physicalLengths.has(graph.physical[edge]!)) repeated += graph.length[edge]!;
      else physicalLengths.set(graph.physical[edge]!, graph.length[edge]!);
      nodes.add(graph.to[edge]!);
    }
    if (elevationProfile?.every(({ elevationMeters }) => Number.isFinite(elevationMeters))) {
      maximumGrade = Math.max(maximumGrade, maximumSustainedGradePct(elevationProfile) ?? 0);
    }
    return {
      distance,
      gain,
      maximumElevation,
      maximumGrade,
      repeated,
      repeatedFraction: distance > 0 ? repeated / distance : 0,
      cycleRank: Math.max(0, physicalLengths.size - nodes.size + 1),
      physicalLengths,
    };
  };

  const violations = (edges: readonly number[], metrics: Metrics): string[] => {
    const result: string[] = [];
    if (edges.length === 0 || graph.to[edges.at(-1)!] !== graph.start) result.push("not-closed");
    if (metrics.distance < minMeters) result.push("distance-below-minimum");
    if (metrics.distance > maxMeters) result.push("distance-above-maximum");
    if (request.elevationGainFeet) {
      const min = request.elevationGainFeet.min * METERS_PER_FOOT;
      const max = request.elevationGainFeet.max * METERS_PER_FOOT;
      if (metrics.gain < min) result.push("gain-below-minimum");
      if (metrics.gain > max) result.push("gain-above-maximum");
    }
    if (request.maximumElevationFeet) {
      const value = metrics.maximumElevation / METERS_PER_FOOT;
      if (value < request.maximumElevationFeet.min || value > request.maximumElevationFeet.max) {
        result.push("maximum-elevation-outside-range");
      }
    }
    if (request.steepestSustainedGradePct
      && (metrics.maximumGrade < request.steepestSustainedGradePct.min
        || metrics.maximumGrade > request.steepestSustainedGradePct.max)) {
      result.push("sustained-grade-outside-range");
    }
    if (metrics.repeatedFraction > maximumRepeatedFraction + 1e-9) result.push("repeated-trail-above-maximum");
    if (metrics.cycleRank === 0) result.push("no-physical-cycle");
    if (!request.closedRoute.allowMultiCycle && metrics.cycleRank > 1) result.push("multiple-cycles-forbidden");
    if (sharedStem(edges) > maximumSharedStemMeters) result.push("shared-stem-above-maximum");
    return result;
  };

  const score = (metrics: Metrics): number => {
    let result = Math.abs(metrics.distance - targetMeters);
    if (request.elevationGainFeet) {
      const min = request.elevationGainFeet.min * METERS_PER_FOOT;
      const max = request.elevationGainFeet.max * METERS_PER_FOOT;
      if (metrics.gain < min) result += (min - metrics.gain) * 5;
      if (metrics.gain > max) result += (metrics.gain - max) * 5;
    }
    return result + metrics.repeated * 0.5;
  };

  const compareCandidate = (left: Candidate, right: Candidate): number => left.score - right.score
    || left.id.localeCompare(right.id);
  const insertBounded = (list: Candidate[], candidate: Candidate, cap: number, reason: string): void => {
    list.push(candidate);
    list.sort(compareCandidate);
    if (list.length > cap) {
      list.length = cap;
      truncationReasons.add(reason);
    }
  };
  const bumpPenalties = (metrics: Metrics, amount: number): void => {
    for (const key of metrics.physicalLengths.keys()) penalties.set(key, (penalties.get(key) ?? 0) + amount);
  };
  const nearEligible = new Set([
    "distance-below-minimum",
    "distance-above-maximum",
    "gain-below-minimum",
    "gain-above-maximum",
    "maximum-elevation-outside-range",
    "sustained-grade-outside-range",
    "repeated-trail-above-maximum",
    "shared-stem-above-maximum",
  ]);

  const offer = (edges: number[]): "accepted" | "reserved" | "duplicate" | "invalid" => {
    checkCancellation();
    if (candidateCount >= options.budget.maximumRawCandidates) {
      truncationReasons.add("maximum-raw-candidates");
      return "invalid";
    }
    const id = `route-${stableHash(edges.map((edge) => graph.directed[edge]).join(","))}`;
    if (seen.has(id)) return "duplicate";
    seen.add(id);
    candidateCount += 1;
    const metrics = evaluate(edges);
    const candidateViolations = violations(edges, metrics);
    const candidate: Candidate = {
      id,
      edges,
      metrics,
      score: score(metrics),
      violations: candidateViolations,
    };
    if (candidateViolations.length > 0) {
      if (candidateViolations.every((item) => nearEligible.has(item))) {
        const target = candidateViolations.some((item) => item.includes("below")) ? nearBelow : nearAbove;
        insertBounded(target, candidate, PENALIZED_SEARCH_CAPS.maximumNearArchive, "near-archive-limit");
      }
      return "invalid";
    }
    validCandidateCount += 1;
    insertBounded(validArchive, candidate, PENALIZED_SEARCH_CAPS.maximumValidArchive, "valid-archive-limit");
    if (provisional.length < request.limit
      && provisional.every((other) => physicalOverlap(candidate.metrics, other.metrics) <= overlapLimit)) {
      provisional.push(candidate);
      bumpPenalties(metrics, 3);
      return "accepted";
    }
    insertBounded(reserve, candidate, PENALIZED_SEARCH_CAPS.maximumReserve, "reserve-limit");
    return "reserved";
  };

  const dijkstra = (
    source: number,
    adjacency: readonly number[][],
    forward: boolean,
    settings: {
      forbid?: ReadonlySet<string>;
      discourage?: ReadonlySet<string>;
      target?: number;
    } = {},
  ): SearchTree => {
    const distance = new Float64Array(graph.nodeIds.length).fill(Number.POSITIVE_INFINITY);
    const realLength = new Float64Array(graph.nodeIds.length).fill(Number.POSITIVE_INFINITY);
    const realGain = new Float64Array(graph.nodeIds.length);
    const parent = new Int32Array(graph.nodeIds.length).fill(-1);
    const settled = new Uint8Array(graph.nodeIds.length);
    distance[source] = 0;
    realLength[source] = 0;
    const heap = new MinHeap();
    heap.push(0, source);
    while (heap.size > 0) {
      if (expandedStates >= options.budget.maximumExpandedStates) {
        truncationReasons.add("maximum-expanded-states");
        break;
      }
      if ((expandedStates & 63) === 0 && outOfTime()) break;
      const current = heap.pop();
      if (settled[current.node] || current.distance > distance[current.node]!) continue;
      settled[current.node] = 1;
      expandedStates += 1;
      if (current.node === settings.target) break;
      for (const edge of adjacency[current.node] ?? []) {
        if (settings.forbid?.has(graph.physical[edge]!)) continue;
        const next = forward ? graph.to[edge]! : graph.from[edge]!;
        let weight = graph.length[edge]! * (1 + (penalties.get(graph.physical[edge]!) ?? 0));
        if (settings.discourage?.has(graph.physical[edge]!)) weight += graph.length[edge]! * 50;
        const nextDistance = current.distance + weight;
        if (nextDistance < distance[next]!) {
          distance[next] = nextDistance;
          realLength[next] = realLength[current.node]! + graph.length[edge]!;
          realGain[next] = realGain[current.node]! + graph.gain[edge]!;
          parent[next] = edge;
          heap.push(nextDistance, next);
        }
      }
    }
    return { realLength, realGain, parent, settled, source };
  };

  const forwardPath = (tree: SearchTree, node: number): number[] | null => {
    const edges: number[] = [];
    for (let cursor = node; cursor !== tree.source;) {
      const edge = tree.parent[cursor]!;
      if (edge < 0) return null;
      edges.push(edge);
      cursor = graph.from[edge]!;
    }
    edges.reverse();
    return edges;
  };
  const reversePath = (tree: SearchTree, node: number): number[] | null => {
    const edges: number[] = [];
    for (let cursor = node; cursor !== tree.source;) {
      const edge = tree.parent[cursor]!;
      if (edge < 0) return null;
      edges.push(edge);
      cursor = graph.to[edge]!;
    }
    return edges;
  };

  const treePairRounds = (stateCap = options.budget.maximumExpandedStates, candidateCap = options.budget.maximumRawCandidates): void => {
    let stalls = 0;
    let round = 0;
    for (; round < PENALIZED_SEARCH_CAPS.maximumRounds && provisional.length < request.limit
      && !exhausted(stateCap, candidateCap); round += 1) {
      const forward = dijkstra(graph.start, graph.outgoing, true);
      const reverse = dijkstra(graph.start, graph.incoming, false);
      const apexes: Array<{ edge: number; score: number }> = [];
      const below: Array<{ edge: number; score: number }> = [];
      for (let edge = 0; edge < graph.traversals.length; edge += 1) {
        if ((edge & 4_095) === 0 && outOfTime()) return;
        const from = graph.from[edge]!;
        const to = graph.to[edge]!;
        if (!forward.settled[from] || !reverse.settled[to]) continue;
        const distance = forward.realLength[from]! + graph.length[edge]! + reverse.realLength[to]!;
        if (distance < minMeters || distance > maxMeters) {
          if (round === 0 && request.closedRoute.allowMultiCycle
            && distance < minMeters && distance >= Math.max(200, minMeters * 0.1)) {
            below.push({ edge, score: minMeters - distance });
          }
          continue;
        }
        let apexScore = Math.abs(distance - targetMeters);
        if (request.elevationGainFeet) {
          const totalGain = forward.realGain[from]! + graph.gain[edge]! + reverse.realGain[to]!;
          const min = request.elevationGainFeet.min * METERS_PER_FOOT;
          const max = request.elevationGainFeet.max * METERS_PER_FOOT;
          if (totalGain < min) apexScore += (min - totalGain) * 5;
          if (totalGain > max) apexScore += (totalGain - max) * 5;
        }
        apexes.push({ edge, score: apexScore });
      }
      below.sort((left, right) => left.score - right.score || left.edge - right.edge);
      if (below.length > 8) truncationReasons.add("below-apex-limit");
      for (const { edge } of below.slice(0, 8)) {
        if (exhausted(stateCap, candidateCap)) break;
        const out = forwardPath(forward, graph.from[edge]!);
        const back = reversePath(reverse, graph.to[edge]!);
        if (out && back) offer([...out, edge, ...back]);
      }
      apexes.sort((left, right) => left.score - right.score || left.edge - right.edge);
      if (apexes.length > PENALIZED_SEARCH_CAPS.maximumAttemptsPerRound) truncationReasons.add("apex-attempt-limit");
      let accepted = 0;
      let bestInvalid: number[] | undefined;
      for (const { edge } of apexes.slice(0, PENALIZED_SEARCH_CAPS.maximumAttemptsPerRound)) {
        if (provisional.length >= request.limit || exhausted(stateCap, candidateCap)) break;
        const out = forwardPath(forward, graph.from[edge]!);
        const back = reversePath(reverse, graph.to[edge]!);
        if (!out || !back) continue;
        const edges = [...out, edge, ...back];
        const result = offer(edges);
        if (result === "accepted" && ++accepted >= 2) break;
        if (result === "invalid" && !bestInvalid) bestInvalid = edges;
      }
      if (accepted === 0) {
        stalls += 1;
        if (apexes.length === 0 || stalls > 6) {
          if (stalls > 6) truncationReasons.add("stall-limit");
          break;
        }
        bumpPenalties(evaluate(bestInvalid ?? [apexes[0]!.edge]), 1.5);
      } else {
        stalls = 0;
      }
    }
    if (round >= PENALIZED_SEARCH_CAPS.maximumRounds && provisional.length < request.limit) {
      truncationReasons.add("round-limit");
    }
  };

  const strictRefinement = (stateCap = options.budget.maximumExpandedStates): void => {
    let outer = 0;
    for (; outer < PENALIZED_SEARCH_CAPS.maximumStrictRounds && provisional.length < request.limit
      && !exhausted(stateCap); outer += 1) {
      const forward = dijkstra(graph.start, graph.outgoing, true);
      const reverse = dijkstra(graph.start, graph.incoming, false);
      const apexes: Array<{ edge: number; score: number }> = [];
      for (let edge = 0; edge < graph.traversals.length; edge += 1) {
        if ((edge & 4_095) === 0 && outOfTime()) return;
        const from = graph.from[edge]!;
        const to = graph.to[edge]!;
        if (!forward.settled[from] || !reverse.settled[to]) continue;
        const distance = forward.realLength[from]! + graph.length[edge]! + reverse.realLength[to]!;
        if (distance <= maxMeters && distance >= minMeters * 0.4) {
          apexes.push({ edge, score: Math.abs(distance - targetMeters) });
        }
      }
      apexes.sort((left, right) => left.score - right.score || left.edge - right.edge);
      if (apexes.length > PENALIZED_SEARCH_CAPS.maximumStrictAttempts) truncationReasons.add("strict-attempt-limit");
      let accepted = false;
      let returnSearches = 0;
      for (const { edge } of apexes.slice(0, PENALIZED_SEARCH_CAPS.maximumStrictAttempts)) {
        if (exhausted(stateCap)) return;
        const out = forwardPath(forward, graph.from[edge]!);
        if (!out) continue;
        const treeBack = reversePath(reverse, graph.to[edge]!);
        const outboundPhysical = new Set([...out, edge].map((item) => graph.physical[item]!));
        const disjoint = treeBack?.every((item) => !outboundPhysical.has(graph.physical[item]!));
        if (treeBack && disjoint && offer([...out, edge, ...treeBack]) === "accepted") {
          accepted = true;
          break;
        }
        if (returnSearches >= PENALIZED_SEARCH_CAPS.maximumStrictReturnSearches) {
          truncationReasons.add("strict-return-search-limit");
          continue;
        }
        returnSearches += 1;
        const strict = maximumRepeatedFraction === 0 || !request.closedRoute.allowMultiCycle;
        const back = dijkstra(graph.to[edge]!, graph.outgoing, true, {
          forbid: strict ? outboundPhysical : undefined,
          discourage: strict ? undefined : outboundPhysical,
          target: graph.start,
        });
        const returnEdges = forwardPath(back, graph.start);
        if (returnEdges && offer([...out, edge, ...returnEdges]) === "accepted") {
          accepted = true;
          break;
        }
      }
      if (!accepted) break;
    }
    if (outer >= PENALIZED_SEARCH_CAPS.maximumStrictRounds && provisional.length < request.limit) {
      truncationReasons.add("strict-round-limit");
    }
  };

  const lollipopRefinement = (): void => {
    if (maximumRepeatedFraction === 0 || outOfTime()) return;
    cachedBridges ??= physicalBridges();
    const component = new Int32Array(graph.nodeIds.length).fill(-1);
    const componentLength: number[] = [];
    const coreAdjacency = new Map<number, Array<{ other: number; length: number }>>();
    const seenPhysical = new Set<string>();
    for (let edge = 0; edge < graph.traversals.length; edge += 1) {
      if ((edge & 1_023) === 0 && outOfTime()) return;
      const physical = graph.physical[edge]!;
      if (cachedBridges.has(physical) || seenPhysical.has(physical)) continue;
      seenPhysical.add(physical);
      const from = graph.from[edge]!;
      const to = graph.to[edge]!;
      coreAdjacency.set(from, [...(coreAdjacency.get(from) ?? []), { other: to, length: graph.length[edge]! }]);
      coreAdjacency.set(to, [...(coreAdjacency.get(to) ?? []), { other: from, length: graph.length[edge]! }]);
    }
    for (const root of [...coreAdjacency.keys()].sort((left, right) => left - right)) {
      if (component[root] !== -1) continue;
      const id = componentLength.length;
      let total = 0;
      const stack = [root];
      component[root] = id;
      while (stack.length > 0) {
        if ((stack.length & 1_023) === 0 && outOfTime()) return;
        const node = stack.pop()!;
        for (const adjacent of coreAdjacency.get(node) ?? []) {
          total += adjacent.length / 2;
          if (component[adjacent.other] === -1) {
            component[adjacent.other] = id;
            stack.push(adjacent.other);
          }
        }
      }
      componentLength.push(total);
    }
    const stemBudget = Math.min(maximumRepeatedFraction * maxMeters, maximumSharedStemMeters, maxMeters / 2);
    const fromStart = dijkstra(graph.start, graph.outgoing, true);
    const bestPivot = new Map<number, number>();
    for (let node = 0; node < graph.nodeIds.length; node += 1) {
      if ((node & 1_023) === 0 && outOfTime()) return;
      const componentId = component[node]!;
      if (!fromStart.settled[node] || componentId < 0 || fromStart.realLength[node]! > stemBudget) continue;
      if (componentLength[componentId]! + 2 * fromStart.realLength[node]! < minMeters) continue;
      const current = bestPivot.get(componentId);
      if (current === undefined || fromStart.realLength[node]! < fromStart.realLength[current]!) bestPivot.set(componentId, node);
    }
    const pivots = [...bestPivot.values()].sort((left, right) =>
      componentLength[component[right]!]! - componentLength[component[left]!]!
      || fromStart.realLength[left]! - fromStart.realLength[right]!
      || left - right);
    if (pivots.length > PENALIZED_SEARCH_CAPS.maximumPivots) truncationReasons.add("pivot-limit");
    for (const pivot of pivots.slice(0, PENALIZED_SEARCH_CAPS.maximumPivots)) {
      if (provisional.length >= request.limit || exhausted()) return;
      const stem = forwardPath(fromStart, pivot);
      if (!stem) continue;
      const stemBack: number[] = [];
      for (let index = stem.length - 1; index >= 0; index -= 1) {
        const edge = stem[index]!;
        const reverse = graph.reverse.get(`${graph.physical[edge]}:${graph.to[edge]}:${graph.from[edge]}`);
        if (reverse === undefined) {
          stemBack.length = 0;
          break;
        }
        stemBack.push(reverse);
      }
      if (stem.length > 0 && stemBack.length === 0) continue;
      const stemPhysical = new Set(stem.map((edge) => graph.physical[edge]!));
      const forward = dijkstra(pivot, graph.outgoing, true, { forbid: stemPhysical });
      const reverse = dijkstra(pivot, graph.incoming, false, { forbid: stemPhysical });
      const apexes: Array<{ edge: number; score: number }> = [];
      const stemLength = stem.reduce((sum, edge) => sum + graph.length[edge]!, 0);
      for (let edge = 0; edge < graph.traversals.length; edge += 1) {
        if ((edge & 4_095) === 0 && outOfTime()) return;
        if (stemPhysical.has(graph.physical[edge]!) || cachedBridges.has(graph.physical[edge]!)) continue;
        const from = graph.from[edge]!;
        const to = graph.to[edge]!;
        if (component[from] !== component[pivot] || !forward.settled[from] || !reverse.settled[to]) continue;
        const distance = 2 * stemLength + forward.realLength[from]! + graph.length[edge]! + reverse.realLength[to]!;
        if (distance <= maxMeters && distance >= minMeters * 0.85) {
          apexes.push({ edge, score: Math.abs(distance - targetMeters) });
        }
      }
      apexes.sort((left, right) => left.score - right.score || left.edge - right.edge);
      if (apexes.length > PENALIZED_SEARCH_CAPS.maximumLollipopAttempts) truncationReasons.add("lollipop-attempt-limit");
      let returnSearches = 0;
      for (const { edge } of apexes.slice(0, PENALIZED_SEARCH_CAPS.maximumLollipopAttempts)) {
        if (exhausted()) return;
        const branch = forwardPath(forward, graph.from[edge]!);
        if (!branch) continue;
        const treeBack = reversePath(reverse, graph.to[edge]!);
        const used = new Set([...branch, edge].map((item) => graph.physical[item]!));
        if (treeBack?.every((item) => !used.has(graph.physical[item]!))) {
          offer([...stem, ...branch, edge, ...treeBack, ...stemBack]);
          continue;
        }
        if (returnSearches >= PENALIZED_SEARCH_CAPS.maximumLollipopReturnSearches) {
          truncationReasons.add("lollipop-return-search-limit");
          continue;
        }
        returnSearches += 1;
        const back = dijkstra(graph.to[edge]!, graph.outgoing, true, {
          forbid: new Set([...stemPhysical, ...used]),
          target: pivot,
        });
        const returnEdges = forwardPath(back, pivot);
        if (returnEdges) offer([...stem, ...branch, edge, ...returnEdges, ...stemBack]);
      }
    }
  };

  const compositionPass = (): void => {
    if (!request.closedRoute.allowMultiCycle) return;
    const pool = [...provisional, ...reserve].sort(compareCandidate);
    if (pool.length > PENALIZED_SEARCH_CAPS.maximumCompositionPool) truncationReasons.add("composition-pool-limit");
    pool.length = Math.min(pool.length, PENALIZED_SEARCH_CAPS.maximumCompositionPool);
    for (let left = 0; left < pool.length && provisional.length < request.limit; left += 1) {
      for (let right = left + 1; right < pool.length && provisional.length < request.limit; right += 1) {
        if (exhausted()) return;
        const distance = pool[left]!.metrics.distance + pool[right]!.metrics.distance;
        if (distance >= minMeters && distance <= maxMeters) offer([...pool[left]!.edges, ...pool[right]!.edges]);
      }
    }
  };

  const assemblyPass = (): void => {
    if (!request.closedRoute.allowMultiCycle) return;
    // A distinct cycle can dilute a short route's repeated-trail fraction.
    // Validate the combined walk instead of rejecting that component early.
    const pool = [...nearBelow.filter((candidate) =>
      candidate.metrics.repeated <= maximumRepeatedFraction * maxMeters
      && candidate.violations.every((item) => item.includes("below") || item === "repeated-trail-above-maximum")), ...validArchive]
      .sort(compareCandidate);
    const pairs: Array<{ left: Candidate; right: Candidate; score: number }> = [];
    let enumerated = 0;
    outer: for (let left = 0; left < pool.length; left += 1) {
      for (let right = left + 1; right < pool.length; right += 1) {
        if (enumerated >= PENALIZED_SEARCH_CAPS.maximumAssemblyPairs) {
          truncationReasons.add("assembly-pair-limit");
          break outer;
        }
        if ((enumerated++ & 255) === 0 && outOfTime()) break outer;
        const distance = pool[left]!.metrics.distance + pool[right]!.metrics.distance;
        if (distance >= minMeters && distance <= maxMeters) {
          pairs.push({ left: pool[left]!, right: pool[right]!, score: Math.abs(distance - targetMeters) });
        }
      }
    }
    pairs.sort((left, right) => left.score - right.score
      || left.left.id.localeCompare(right.left.id)
      || left.right.id.localeCompare(right.right.id));
    if (pairs.length > PENALIZED_SEARCH_CAPS.maximumAssemblyOffers) truncationReasons.add("assembly-offer-limit");
    for (const pair of pairs.slice(0, PENALIZED_SEARCH_CAPS.maximumAssemblyOffers)) {
      if (exhausted()) return;
      assemblyAttempts += 1;
      if (offer([...pair.left.edges, ...pair.right.edges]) === "accepted") assemblyAccepted += 1;
    }
  };

  const repairPass = (): void => {
    const repairable = [...nearAbove].sort(compareCandidate);
    if (repairable.length > PENALIZED_SEARCH_CAPS.maximumRepairCandidates) truncationReasons.add("repair-candidate-limit");
    for (const candidate of repairable.slice(0, PENALIZED_SEARCH_CAPS.maximumRepairCandidates)) {
      if (provisional.length >= request.limit || exhausted()) return;
      const nodes = [graph.start, ...candidate.edges.map((edge) => graph.to[edge]!)];
      const firstSeen = new Map<number, number>();
      let spans = 0;
      for (let right = 0; right < nodes.length; right += 1) {
        if ((right & 63) === 0 && outOfTime()) return;
        const node = nodes[right]!;
        const left = firstSeen.get(node);
        if (left === undefined) {
          firstSeen.set(node, right);
          continue;
        }
        if (spans++ >= PENALIZED_SEARCH_CAPS.maximumRepairSpans) {
          truncationReasons.add("repair-span-limit");
          break;
        }
        const repaired = [...candidate.edges.slice(0, left), ...candidate.edges.slice(right)];
        const distance = repaired.reduce((sum, edge) => sum + graph.length[edge]!, 0);
        if (repaired.length === 0 || distance < minMeters || distance > maxMeters) continue;
        repairAttempts += 1;
        if (offer(repaired) === "accepted") {
          repairAccepted += 1;
          break;
        }
      }
    }
  };

  if (graph.start >= 0 && graph.traversals.length > 0 && !outOfTime()) {
    if (!request.closedRoute.allowMultiCycle || maximumRepeatedFraction === 0) {
      strictRefinement(Math.floor(options.budget.maximumExpandedStates * 0.45));
      if (provisional.length < request.limit) lollipopRefinement();
      if (provisional.length < request.limit) treePairRounds();
    } else {
      treePairRounds(
        Math.floor(options.budget.maximumExpandedStates * 0.4),
        Math.floor(options.budget.maximumRawCandidates * 0.5),
      );
      if (provisional.length < request.limit) strictRefinement();
      if (provisional.length < request.limit) treePairRounds();
      if (provisional.length < request.limit) compositionPass();
    }
    if (provisional.length < request.limit && !exhausted()) assemblyPass();
    if (provisional.length < request.limit && !exhausted()) repairPass();
  }

  const select = (pool: readonly Candidate[], limit: number): Candidate[] => {
    const selected: Candidate[] = [];
    for (const candidate of [...pool].sort(compareCandidate)) {
      checkCancellation();
      if (selected.length >= limit || outOfTime()) break;
      if (selected.every((other) => physicalOverlap(candidate.metrics, other.metrics) <= overlapLimit)) {
        selected.push(candidate);
      }
    }
    return selected;
  };
  const selected = select(validArchive, request.limit);
  const near = [...nearBelow, ...nearAbove].sort(compareCandidate).slice(0, PENALIZED_SEARCH_CAPS.maximumNearResults);
  const materialize = (candidate: Candidate): PenalizedClosedRouteCandidate => ({
    id: candidate.id,
    traversals: candidate.edges.flatMap((edge) => graph.traversals[edge]!),
    distanceMeters: candidate.metrics.distance,
    elevationGainMeters: candidate.metrics.gain,
    repeatedEdgeFraction: candidate.metrics.repeatedFraction,
    score: candidate.score,
    violatedConstraints: [...candidate.violations],
  });
  const reasons = [...truncationReasons].sort();
  return {
    candidates: selected.map(materialize),
    nearCandidates: near.map(materialize),
    diagnostics: {
      elapsedMs: Math.max(0, now() - startedAt),
      expandedStates,
      candidateCount,
      validCandidateCount,
      repairAttempts,
      repairAccepted,
      assemblyAttempts,
      assemblyAccepted,
      exhausted: reasons.length > 0,
      truncationReasons: reasons,
    },
  };
}
