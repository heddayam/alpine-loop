import type { RouteSearchRequest } from "./types";
import { CLOSE_MATCH_DISTANCE_MULTIPLIER } from "@/lib/contracts/routes";
import { decomposeCycleBlocks } from "./cycle-blocks";
import { routeElevationMetrics } from "./route-elevation";
import { rankRouteMetrics } from "./route-quality";
import type { GradeExperienceMetrics } from "@/lib/contracts";
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
  gradeExperience?: GradeExperienceMetrics;
  trailNames: string[];
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
  violationMagnitude: number;
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
function minimumReturnDistances(graph: InternalGraph, stop: () => boolean, expand: () => void, residual?: {
  seeds: Array<[number, number]>;
  target: number;
  maximumDistance: number;
  allows: (edge: number) => boolean;
}): Float64Array {
  const best = new Float64Array(graph.nodeIds.length).fill(Infinity);
  if (graph.start < 0) return best;
  const heap: Array<{ node: number; distance: number }> = [];
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
  for (const [node, distance] of residual?.seeds ?? [[graph.start, 0]]) {
    if (distance < best[node]!) { best[node] = distance; push({ node, distance }); }
  }
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
    if (current.node === residual?.target) break;
    for (const edge of graph.incoming[current.node]!) {
      if (residual && !residual.allows(edge)) continue;
      const next = graph.from[edge]!;
      const distance = current.distance + graph.length[edge]!;
      if (distance < best[next]! && distance <= (residual?.maximumDistance ?? Infinity)) {
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
  // The raw-candidate budget bounds this archive. Repeated approaches and
  // directions compete within one physical cycle instead of crowding other
  // loops out of a fixed top-score list.
  const archive = new Map<string, Candidate>();
  let expandedStates = 0;
  let candidateCount = 0;
  let validCandidateCount = 0;
  const maxMeters = request.distanceMiles.max * METERS_PER_MILE;
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

  const evaluate = (edges: readonly number[], attachment: number): Metrics => {
    let distance = 0;
    let gain = 0;
    let maximumElevation = Number.NEGATIVE_INFINITY;
    let repeated = 0;
    const physicalLengths = new Map<string, number>();
    const visited = new Set<string>();
    const names = new Set<string>();
    for (const [index, edge] of edges.entries()) {
      distance += graph.length[edge]!;
      gain += graph.gain[edge]!;
      maximumElevation = Math.max(maximumElevation, graph.maximumElevation[edge]!);
      if (visited.has(graph.physical[edge]!)) repeated += graph.length[edge]!;
      visited.add(graph.physical[edge]!);
      // Diversity describes the loop itself; a common approach is not overlap
      // between two otherwise distinct physical loops.
      if (index >= attachment && index < edges.length - attachment) physicalLengths.set(graph.physical[edge]!, graph.length[edge]!);
      for (const traversal of graph.traversals[edge]!) if (traversal.edge.trailName) names.add(traversal.edge.trailName);
    }
    const elevation = request.steepestSustainedGradePct || request.gradeExperience
      ? routeElevationMetrics(edges.flatMap(edge => graph.traversals[edge]!.map(traversal => ({
        ...traversal.edge, fromElevationMeters: traversal.from.elevationMeters, toElevationMeters: traversal.to.elevationMeters,
      }))), Boolean(request.gradeExperience)) : null;
    return { distance, gain, maximumElevation, maximumGrade: elevation?.grade ?? 0,
      ...(elevation?.experience ? { gradeExperience: elevation.experience } : {}), trailNames: [...names],
      repeated, repeatedFraction: distance > 0 ? repeated / distance : 0, physicalLengths };
  };

  const compareCandidate = (left: Candidate, right: Candidate): number => left.violations.length - right.violations.length
    || left.violationMagnitude - right.violationMagnitude || left.score - right.score || left.id.localeCompare(right.id);
  const offer = (edges: number[], attachment: number, stemDistance: number): void => {
    const identity = edges.map((edge) => graph.directed[edge]).join(",");
    if (seen.has(identity)) return;
    seen.add(identity);
    candidateCount += 1;
    const metrics = evaluate(edges, attachment);
    if (request.gradeExperience && !metrics.gradeExperience) return;
    const ranked = rankRouteMetrics({ distanceMeters: metrics.distance, elevationGainMeters: metrics.gain,
      maximumElevationMeters: metrics.maximumElevation, steepestSustainedGradePct: metrics.maximumGrade,
      gradeExperience: metrics.gradeExperience, trailNames: metrics.trailNames,
      topology: { repeatedTrailFraction: metrics.repeatedFraction, sharedStemDistanceMeters: stemDistance },
      startAccessPoint: { confidence: typeof start === "string" ? "high" : start.confidence } }, request);
    const violations = ranked.violations.map(({ constraint, value, min }) => {
      const side = value < min ? "below-minimum" : "above-maximum";
      if (constraint === "distance") return `distance-${side}`;
      if (constraint === "elevation-gain") return `gain-${side}`;
      if (constraint === "maximum-elevation") return "maximum-elevation-outside-range";
      if (constraint === "steepest-sustained-grade") return "sustained-grade-outside-range";
      return `${constraint}-${side}`;
    });
    if (ranked.exact) validCandidateCount += 1;
    const candidate: Candidate = { id: identity, edges, metrics, score: ranked.score, violations,
      violationMagnitude: ranked.violations.reduce((sum, item) => sum + item.normalizedDelta, 0) };
    const loopKey = JSON.stringify([...metrics.physicalLengths.keys()].sort());
    const previous = archive.get(loopKey);
    if (!previous || compareCandidate(candidate, previous) < 0) archive.set(loopKey, candidate);
  };

  // Exact matches have priority. Both passes use this one traversal; the
  // fallback relaxes numerical ranges only, never topology or legal access.
  // Reserve a small bounded part of unsuccessful searches for a close match.
  if (graph.start >= 0 && !outOfTime()) {
    const { edgeBlock, blocks } = decomposeCycleBlocks({ ...graph, nodeCount: graph.nodeIds.length }, options.signal);
    const returnDistances = minimumReturnDistances(graph, exhausted, () => { expandedStates += 1; });
    const maximumGain = request.elevationGainFeet ? request.elevationGainFeet.max * 0.3048 : Infinity;
    const minimumGain = request.elevationGainFeet ? request.elevationGainFeet.min * 0.3048 : 0;
    const minimumDistance = request.distanceMiles.min * METERS_PER_MILE;
    const maximumElevation = request.maximumElevationFeet ? request.maximumElevationFeet.max * 0.3048 : Infinity;
    const maximumStem = request.closedRoute.maximumSharedStemMiles === undefined ? Infinity
      : request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE;
    const maximumRepeat = request.closedRoute.maximumRepeatedTrailPct / 100;
    const enumerate = (exactOnly: boolean): void => {
      const path: number[] = [];
      const usedPhysical = new Set<string>();
      const positions = new Map<number, number>([[graph.start, 0]]);
      const distances = [0], gains = [0], elevations = [-Infinity];
      const reverses: number[] = [];
      const reverseDistances = [0], reverseGains = [0];
      const frameFor = (node: number) => ({ node, next: 0, edges: [...graph.outgoing[node]!].sort((a, b) =>
        Number(positions.has(graph.to[b]!)) - Number(positions.has(graph.to[a]!))
        || graph.length[a]! + returnDistances[graph.to[a]!]! - graph.length[b]! - returnDistances[graph.to[b]!]!
        || a - b) });
      const frames = [frameFor(graph.start)];
      const explorationDistance = maxMeters * (exactOnly ? 1 : CLOSE_MATCH_DISTANCE_MULTIPLIER);
      const phaseExhausted = (): boolean => {
        if (exhausted()) return true;
        if (exactOnly && validCandidateCount === 0
          && (expandedStates >= options.budget.maximumExpandedStates * 0.9 || now() - startedAt >= options.budget.deadlineMs * 0.9)) {
          truncationReasons.add("exact-search-limit");
          return true;
        }
        return false;
      };
      while (frames.length > 0 && !phaseExhausted()) {
        const frame = frames.at(-1)!;
        if (frame.next === frame.edges.length) {
          frames.pop();
          if (path.length > 0) {
            positions.delete(frame.node);
            usedPhysical.delete(graph.physical[path.pop()!]!);
            distances.pop(); gains.pop(); elevations.pop(); reverses.pop(); reverseDistances.pop(); reverseGains.pop();
          }
          continue;
        }
        const edge = frame.edges[frame.next++]!;
        expandedStates += 1;
        const key = graph.physical[edge]!;
        if (usedPhysical.has(key)) continue;
        const next = graph.to[edge]!;
        const distance = distances.at(-1)! + graph.length[edge]!;
        const gain = gains.at(-1)! + graph.gain[edge]!;
        const elevation = Math.max(elevations.at(-1)!, graph.maximumElevation[edge]!);
        if (exactOnly && (gain > maximumGain || elevation > maximumElevation)) continue;
        const attachment = positions.get(next);
        if (attachment !== undefined) {
          const backDistance = reverseDistances[attachment]!;
          if (!Number.isFinite(backDistance)) continue;
          const totalDistance = distance + backDistance;
          if (totalDistance > explorationDistance) continue;
          const totalGain = gain + reverseGains[attachment]!;
          const stemDistance = distances[attachment]!;
          // These are necessary exact-match conditions. Minimum ranges are
          // tested only on a completed route, never used to discard a prefix.
          if (exactOnly && (totalDistance < minimumDistance || totalGain < minimumGain || totalGain > maximumGain
            || stemDistance > maximumStem || backDistance > totalDistance * maximumRepeat + 1e-9)) continue;
          offer([...path, edge, ...reverses.slice(0, attachment).reverse()], attachment, stemDistance);
          continue;
        }
        if (!Number.isFinite(returnDistances[next]) || distance + returnDistances[next]! > explorationDistance) continue;
        const reverse = graph.reverse.get(`${key}:${next}:${frame.node}`) ?? -1;
        const backDistance = reverseDistances.at(-1)! + (reverse < 0 ? Infinity : graph.length[reverse]!);
        const backGain = reverseGains.at(-1)! + (reverse < 0 ? Infinity : graph.gain[reverse]!);
        // A simple cycle cannot cross blocks. After leaving one block, the
        // entire earlier prefix must be the reversible stem of any later loop.
        // Keep every alternative path within a block, including longer stems.
        const enteringBlock = path.length > 0 && edgeBlock[path.at(-1)!] !== edgeBlock[edge];
        if (enteringBlock && (!Number.isFinite(reverseDistances.at(-1)!) || (exactOnly
          && (distances.at(-1)! > maximumStem || reverseDistances.at(-1)! > maxMeters * maximumRepeat
            || gains.at(-1)! + reverseGains.at(-1)! > maximumGain)))) continue;
        // Bridges can only be part of a stem; their reverse is mandatory.
        if (!blocks[edgeBlock[edge]!]!.cyclic && (!Number.isFinite(backDistance) || (exactOnly
          && (distance > maximumStem || backDistance > maxMeters * maximumRepeat || gain + backGain > maximumGain)))) continue;
        path.push(edge);
        usedPhysical.add(key);
        positions.set(next, path.length);
        distances.push(distance); gains.push(gain); elevations.push(elevation);
        reverses.push(reverse); reverseDistances.push(backDistance); reverseGains.push(backGain);
        // Once this prefix cannot be a stem, every completion must close to
        // an existing eligible ancestor. Recompute a weighted return bound in
        // this exact residual graph; never cache path-relative blocking state.
        // Ancestors are terminal targets, seeded with their actual stem return
        // cost. Used physical trails and all other prefix nodes are forbidden.
        // This also covers lollipops, unlike banning the whole prefix and
        // insisting on a new path directly to the start.
        const canExtendStem = Number.isFinite(backDistance) && distance <= maximumStem
          && backDistance <= maxMeters * maximumRepeat && gain + backGain <= maximumGain;
        if (exactOnly && !canExtendStem) {
          const seeds: Array<[number, number]> = [];
          for (const [node, index] of positions) {
            if (node !== next && Number.isFinite(reverseDistances[index]) && distances[index]! <= maximumStem
              && reverseDistances[index]! <= maxMeters * maximumRepeat
              && gains[index]! + reverseGains[index]! <= maximumGain) seeds.push([node, reverseDistances[index]!]);
          }
          const residual = minimumReturnDistances(graph, phaseExhausted, () => { expandedStates += 1; }, {
            seeds, target: next, maximumDistance: maxMeters - distance,
            allows: edge => !usedPhysical.has(graph.physical[edge]!)
              && (!positions.has(graph.from[edge]!) || graph.from[edge] === next),
          });
          if (phaseExhausted()) return;
          if (distance + residual[next]! > maxMeters) {
            positions.delete(next); usedPhysical.delete(key); path.pop();
            distances.pop(); gains.pop(); elevations.pop(); reverses.pop(); reverseDistances.pop(); reverseGains.pop();
            continue;
          }
        }
        frames.push(frameFor(next));
      }
    };
    enumerate(true);
    if (validCandidateCount === 0 && !exhausted()) enumerate(false);
  }

  const select = (pool: readonly Candidate[], limit: number): Candidate[] => {
    const selected: Candidate[] = [];
    for (const candidate of [...pool].sort(compareCandidate)) {
      checkCancellation();
      if (selected.length >= limit) break;
      if (overlapLimit >= 1 || selected.every((other) => physicalOverlap(candidate.metrics, other.metrics) <= overlapLimit)) {
        selected.push(candidate);
      }
    }
    return selected;
  };
  const selected = select([...archive.values()].filter(candidate => candidate.violations.length === 0), request.limit);
  const near = select([...archive.values()].filter(candidate => candidate.violations.length > 0), MAXIMUM_NEAR_RESULTS);
  const materialize = (candidate: Candidate): SimpleRouteCandidate => ({
    id: `route-${stableHash(candidate.id)}`,
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
