import type { RouteSearchRequest } from "./types";
import { CLOSE_MATCH_DISTANCE_MULTIPLIER } from "@/lib/contracts/routes";
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

const MAXIMUM_VALID_ARCHIVE = 256;
const MAXIMUM_NEAR_ARCHIVE = 64;
const MAXIMUM_NEAR_RESULTS = 5;

export type SimpleRouteCandidate = {
  id: string;
  traversals: EdgeTraversal[];
  distanceMeters: number;
  elevationGainMeters: number;
  repeatedEdgeFraction: number;
  score: number;
  violatedConstraints: string[];
};

export type SimpleRouteSearchDiagnostics = {
  elapsedMs: number;
  expandedStates: number;
  candidateCount: number;
  validCandidateCount: number;
  exhausted: boolean;
  truncationReasons: string[];
};

export type SimpleRouteSearchResult = {
  candidates: SimpleRouteCandidate[];
  nearCandidates: SimpleRouteCandidate[];
  diagnostics: SimpleRouteSearchDiagnostics;
};

export type SimpleRouteSearchOptions = {
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
  physicalLengths: Map<string, number>;
};

type Candidate = {
  id: string;
  edges: number[];
  metrics: Metrics;
  score: number;
  violations: string[];
};

function buildGraph(
  graph: InducedGraph,
  startNodeId: string,
  includeUncertainAccess: boolean,
  maximumDirectedEdges: number,
  signal?: AbortSignal,
): InternalGraph {
  const originals: EdgeTraversal[] = [];
  for (const [index, edge] of graph.edges.entries()) {
    if (index >= maximumDirectedEdges) break;
    if ((index & 1023) === 0 && signal?.aborted) throw new RouteSearchCancelledError(signal.reason);
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

/** Reverse Dijkstra gives an admissible distance bound for every return,
 * including a retraced stem. Unlike hop-count blocking, this remains valid
 * for unequal trail lengths and every path-local forbidden-node set. */
function minimumReturnDistances(graph: InternalGraph, stop: () => boolean, expand: () => void): Float64Array {
  const best = new Float64Array(graph.nodeIds.length).fill(Infinity);
  if (graph.start < 0) return best;
  best[graph.start] = 0;
  const heap: Array<{ node: number; distance: number }> = [{ node: graph.start, distance: 0 }];
  const push = (item: typeof heap[number]): void => {
    let index = heap.length;
    heap.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.distance <= item.distance) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = item;
  };
  while (heap.length > 0 && !stop()) {
    const current = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]!.distance < heap[child]!.distance) child += 1;
        if (last.distance <= heap[child]!.distance) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
    }
    if (current.distance !== best[current.node]) continue;
    expand();
    for (const edge of graph.incoming[current.node]!) {
      const next = graph.from[edge]!;
      const distance = current.distance + graph.length[edge]!;
      if (distance < best[next]!) {
        best[next] = distance;
        push({ node: next, distance });
      }
    }
  }
  return best;
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

export function searchSimpleRoutes(
  sourceGraph: InducedGraph,
  start: GraphAccessPoint | string,
  request: RouteSearchRequest,
  options: SimpleRouteSearchOptions,
): SimpleRouteSearchResult {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + options.budget.deadlineMs;
  if (options.signal?.aborted) throw new RouteSearchCancelledError(options.signal.reason);
  const graph = buildGraph(
    sourceGraph,
    typeof start === "string" ? start : start.nodeId,
    request.includeUncertainAccess,
    options.budget.maximumDirectedEdges,
    options.signal,
  );
  const truncationReasons = new Set<string>();
  const seen = new Set<string>();
  const validArchive: Candidate[] = [];
  const nearBelow: Candidate[] = [];
  const nearAbove: Candidate[] = [];
  let expandedStates = 0;
  let candidateCount = 0;
  let validCandidateCount = 0;
  const minMeters = request.distanceMiles.min * METERS_PER_MILE;
  const maxMeters = request.distanceMiles.max * METERS_PER_MILE;
  const targetMeters = (minMeters + maxMeters) / 2;
  const maximumRepeatedFraction = request.closedRoute.maximumRepeatedTrailPct / 100;
  const maximumSharedStemMeters = request.closedRoute.maximumSharedStemMiles === undefined
    ? Number.POSITIVE_INFINITY
    : request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE;
  const overlapLimit = options.maximumRouteOverlapFraction ?? 0.8;

  if (sourceGraph.edges.length > options.budget.maximumDirectedEdges) {
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

  const evaluate = (edges: readonly number[]): Metrics => {
    let distance = 0;
    let gain = 0;
    let maximumElevation = Number.NEGATIVE_INFINITY;
    let maximumGrade = 0;
    let repeated = 0;
    const physicalLengths = new Map<string, number>();
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
      physicalLengths,
    };
  };

  const violations = (edges: readonly number[], metrics: Metrics, stemDistance: number): string[] => {
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
    if (stemDistance > maximumSharedStemMeters) result.push("shared-stem-above-maximum");
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
  const offer = (edges: number[], stemDistance: number): void => {
    const id = `route-${stableHash(edges.map((edge) => graph.directed[edge]).join(","))}`;
    if (seen.has(id)) return;
    seen.add(id);
    candidateCount += 1;
    const metrics = evaluate(edges);
    const candidateViolations = violations(edges, metrics, stemDistance);
    const candidate = { id, edges, metrics, score: score(metrics), violations: candidateViolations };
    if (candidateViolations.length === 0) {
      validCandidateCount += 1;
      insertBounded(validArchive, candidate, MAXIMUM_VALID_ARCHIVE, "valid-archive-limit");
    } else {
      const target = candidateViolations.some((item) => item.includes("below")) ? nearBelow : nearAbove;
      insertBounded(target, candidate, MAXIMUM_NEAR_ARCHIVE, "near-archive-limit");
    }
  };

  // A simple path from the start contains every possible stem + unfinished
  // cycle. Closing to an ancestor supplies exactly one cycle. The prefix is
  // returned along the same physical trails, only when every reverse exists.
  // No cycle composition, arbitrary closed walks, or repair pass is needed.
  if (graph.start >= 0 && !outOfTime()) {
    const returnDistances = minimumReturnDistances(graph, exhausted, () => { expandedStates += 1; });
    const path: number[] = [];
    const usedPhysical = new Set<string>();
    const positions = new Map<number, number>([[graph.start, 0]]);
    const distances = [0];
    const reverses: number[] = [];
    const irreversiblePrefixCounts = [0];
    const frameFor = (node: number) => ({ node, next: 0, edges: [...graph.outgoing[node]!].sort((a, b) =>
      Number(positions.has(graph.to[b]!)) - Number(positions.has(graph.to[a]!))
      || graph.length[a]! + returnDistances[graph.to[a]!]! - graph.length[b]! - returnDistances[graph.to[b]!]!
      || a - b) });
    const frames = [frameFor(graph.start)];
    // Permit nearby over-distance matches, but never explore unbounded paths
    // merely because the exact target cannot be met.
    const explorationDistance = maxMeters * CLOSE_MATCH_DISTANCE_MULTIPLIER;
    while (frames.length > 0 && !exhausted()) {
      const frame = frames.at(-1)!;
      const outgoing = frame.edges;
      if (frame.next === outgoing.length) {
        frames.pop();
        if (path.length > 0) {
          positions.delete(frame.node);
          usedPhysical.delete(graph.physical[path.pop()!]!);
          distances.pop();
          reverses.pop();
          irreversiblePrefixCounts.pop();
        }
        continue;
      }
      const edge = outgoing[frame.next++]!;
      expandedStates += 1;
      const key = graph.physical[edge]!;
      if (usedPhysical.has(key)) continue;
      const next = graph.to[edge]!;
      const distance = distances.at(-1)! + graph.length[edge]!;
      const attachment = positions.get(next);
      if (attachment !== undefined) {
        if (irreversiblePrefixCounts[attachment] !== 0) continue;
        const stemDistance = distances[attachment]!;
        offer([...path, edge, ...reverses.slice(0, attachment).reverse()], stemDistance);
        continue;
      }
      if (!Number.isFinite(returnDistances[next]) || distance + returnDistances[next]! > explorationDistance) continue;
      path.push(edge);
      usedPhysical.add(key);
      positions.set(next, path.length);
      distances.push(distance);
      const reverse = graph.reverse.get(`${key}:${next}:${frame.node}`) ?? -1;
      reverses.push(reverse);
      irreversiblePrefixCounts.push(irreversiblePrefixCounts.at(-1)! + Number(reverse < 0));
      frames.push(frameFor(next));
    }
  }

  const select = (pool: readonly Candidate[], limit: number): Candidate[] => {
    const selected: Candidate[] = [];
    for (const candidate of [...pool].sort(compareCandidate)) {
      checkCancellation();
      if (selected.length >= limit) break;
      if (selected.every((other) => physicalOverlap(candidate.metrics, other.metrics) <= overlapLimit)) {
        selected.push(candidate);
      }
    }
    return selected;
  };
  const selected = select(validArchive, request.limit);
  const near = [...nearBelow, ...nearAbove].sort(compareCandidate).slice(0, MAXIMUM_NEAR_RESULTS);
  const materialize = (candidate: Candidate): SimpleRouteCandidate => ({
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
      exhausted: reasons.length > 0,
      truncationReasons: reasons,
    },
  };
}
