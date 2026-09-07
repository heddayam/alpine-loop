/** Experimental closed-walk search: every proposal replaces one span via one pivot arc. */
import { maximumSustainedGradePct, SUSTAINED_GRADE_WINDOW_M } from "../../lib/data/metrics";
import { edgeIsTraversable, type EdgeTraversal, type GraphAccessPoint, type InducedGraph } from "../../lib/graph";
import { contractCorridors, physicalKeyOf } from "../../lib/solver/contract-corridors";
import { RouteSearchCancelledError } from "../../lib/solver/control";
import { stableHash } from "../../lib/solver/route-identity";
import type { RouteSearchRequest } from "../../lib/solver/types";
import type {
  PenalizedClosedRouteCandidate, PenalizedClosedRouteSearchOptions, PenalizedClosedRouteSearchResult,
} from "../../lib/solver/penalized-closed-route-search";

const MILE = 1609.344;
const FOOT = 0.3048;
type Arc = { chain: EdgeTraversal[]; from: string; to: string; key: string; id: string; length: number; gain: number };
type Walk = { edges: Arc[]; id: string; distance: number; gain: number; repeated: number;
  score: number; fitness: number; violations: string[]; physical: Map<string, number> };
type Tree = { source: string; parent: Map<string, Arc>; length: Map<string, number> };

class Heap {
  items: Array<[number, string]> = [];
  push(value: [number, string]): void {
    let index = this.items.length;
    this.items.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent]![0] <= value[0]) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = value;
  }
  pop(): [number, string] {
    const first = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1]![0] < this.items[child]![0]) child++;
        if (last[0] <= this.items[child]![0]) break;
        this.items[index] = this.items[child]!;
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function overlap(left: Walk, right: Walk): number {
  let shared = 0;
  for (const [key, length] of left.physical) shared += Math.min(length, right.physical.get(key) ?? 0);
  return shared / Math.max(1, Math.min(left.distance - left.repeated, right.distance - right.repeated));
}

export function searchPenalizedClosedRoutes(
  sourceGraph: InducedGraph, start: GraphAccessPoint | string, request: RouteSearchRequest,
  options: PenalizedClosedRouteSearchOptions,
): PenalizedClosedRouteSearchResult {
  const now = options.now ?? Date.now;
  const started = now();
  const root = typeof start === "string" ? start : start.nodeId;
  const reasons = new Set<string>();
  let expandedStates = 0;
  let candidateCount = 0;
  let validCandidateCount = 0;
  let moves = 0;
  const stopped = (): boolean => {
    if (options.signal?.aborted) throw new RouteSearchCancelledError(options.signal.reason);
    if (now() >= started + options.budget.deadlineMs) reasons.add("deadline");
    if (expandedStates >= options.budget.maximumExpandedStates) reasons.add("maximum-expanded-states");
    if (candidateCount >= options.budget.maximumRawCandidates) reasons.add("maximum-raw-candidates");
    return reasons.has("deadline") || reasons.has("maximum-expanded-states") || reasons.has("maximum-raw-candidates");
  };
  stopped();
  const originals: EdgeTraversal[] = [];
  for (const edge of sourceGraph.edges) {
    const from = sourceGraph.nodes.get(edge.fromNodeId);
    const to = sourceGraph.nodes.get(edge.toNodeId);
    if (from && to && edgeIsTraversable(edge, request.includeUncertainAccess)) originals.push({ edge, from, to });
  }
  originals.sort((a, b) => a.edge.id.localeCompare(b.edge.id) || a.from.id.localeCompare(b.from.id));
  if (originals.length > options.budget.maximumDirectedEdges) reasons.add("maximum-directed-edges");
  const arcs: Arc[] = contractCorridors(originals, root).map((chain) => {
    const keys = chain.map(({ edge }) => physicalKeyOf(edge));
    return { chain, from: chain[0]!.from.id, to: chain.at(-1)!.to.id,
      key: [keys.join("|"), [...keys].reverse().join("|")].sort()[0]!,
      id: chain.map(({ edge }) => edge.edgeKey ?? edge.id).join(","),
      length: chain.reduce((sum, { edge }) => sum + edge.lengthMeters, 0),
      gain: chain.reduce((sum, { edge }) => sum + edge.gainMeters, 0) };
  });
  const outgoing = new Map<string, Arc[]>();
  const incoming = new Map<string, Arc[]>();
  for (const arc of arcs) {
    outgoing.set(arc.from, [...(outgoing.get(arc.from) ?? []), arc]);
    incoming.set(arc.to, [...(incoming.get(arc.to) ?? []), arc]);
  }
  const minimum = request.distanceMiles.min * MILE;
  const maximum = request.distanceMiles.max * MILE;
  const target = (minimum + maximum) / 2;
  const repetitionLimit = request.closedRoute.maximumRepeatedTrailPct / 100;
  const sharedStemLimit = (request.closedRoute.maximumSharedStemMiles ?? Infinity) * MILE;
  const seen = new Set<string>();
  const archive: Walk[] = [];
  let pool: Walk[] = [];
  const exposure = new Map<string, number>();
  let randomState = 0x9e3779b9;
  const random = (): number => {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    return (randomState >>> 0) / 4294967296;
  };

  // Normalize every proposal before measuring it: immediate reversals and minor
  // closed excursions cannot pad its length. Original endpoints distinguish ring directions.
  const trim = (walk: Arc[]): Arc[] => {
    const threshold = Math.min(0.5 * MILE, walk.reduce((sum, arc) => sum + arc.length, 0) * 0.2);
    const result: Arc[] = [];
    const distances = [0];
    const visits = new Map<string, number[]>([[root, [0]]]);
    const pop = (): void => { visits.get(result.pop()!.to)!.pop(); distances.pop(); };
    for (const arc of walk) {
      const previous = result.at(-1);
      const first = previous?.chain[0];
      const last = arc.chain.at(-1)!;
      if (previous?.key === arc.key && first?.from.id === last.to.id && first?.to.id === last.from.id) {
        pop(); continue;
      }
      result.push(arc);
      distances.push(distances.at(-1)! + arc.length);
      const positions = visits.get(arc.to) ?? [];
      const left = positions.at(-1);
      positions.push(result.length);
      visits.set(arc.to, positions);
      if (left !== undefined) {
        const previous = new Set(result.slice(0, left).map((edge) => edge.key));
        const redundant = result.slice(left).every((edge) => previous.has(edge.key));
        if (redundant || distances.at(-1)! - distances[left]! <= threshold) {
          while (result.length > left) pop();
        }
      }
    }
    return result;
  };

  // Bridge decomposition belongs to route evaluation, independent of the search move.
  const sharedStem = (edges: Arc[]): number => {
    if (!Number.isFinite(sharedStemLimit)) return 0;
    const unique = new Map(edges.map((arc) => [arc.key, arc]));
    const adjacency = new Map<string, Array<{ node: string; arc: Arc }>>();
    for (const arc of unique.values()) {
      adjacency.set(arc.from, [...(adjacency.get(arc.from) ?? []), { node: arc.to, arc }]);
      adjacency.set(arc.to, [...(adjacency.get(arc.to) ?? []), { node: arc.from, arc }]);
    }
    const entered = new Map<string, number>();
    const low = new Map<string, number>();
    const bridges = new Set<string>();
    const visit = (node: string, parent?: string): void => {
      entered.set(node, entered.size + 1); low.set(node, entered.get(node)!);
      for (const next of adjacency.get(node) ?? []) {
        if (next.arc.key === parent) continue;
        if (!entered.has(next.node)) {
          visit(next.node, next.arc.key);
          low.set(node, Math.min(low.get(node)!, low.get(next.node)!));
          if (low.get(next.node)! > entered.get(node)!) bridges.add(next.arc.key);
        } else low.set(node, Math.min(low.get(node)!, entered.get(next.node)!));
      }
    };
    visit(root);
    let length = 0;
    for (let left = 0, right = edges.length - 1; left < right; left++, right--) {
      if (edges[left]!.key !== edges[right]!.key || !bridges.has(edges[left]!.key)) break;
      length += edges[left]!.length;
    }
    return length;
  };

  const identity = (edges: Arc[]): string => `route-${stableHash(edges.map((arc) => arc.id).join(","))}`;
  const evaluate = (edges: Arc[], id = identity(edges)): Walk => {
    const physical = new Map<string, number>();
    const nodes = new Set([root]);
    let distance = 0, gain = 0, repeated = 0, maximumElevation = -Infinity, grade = 0;
    const profile = [{ distanceMeters: 0, elevationMeters: sourceGraph.nodes.get(root)?.elevationMeters ?? NaN }];
    for (const arc of edges) {
      if (physical.has(arc.key)) repeated += arc.length;
      else physical.set(arc.key, arc.length);
      nodes.add(arc.to);
      gain += arc.gain;
      for (const { edge, to } of arc.chain) {
        distance += edge.lengthMeters;
        maximumElevation = Math.max(maximumElevation, edge.maximumElevationMeters ?? -Infinity);
        if (request.steepestSustainedGradePct) {
          if (edge.lengthMeters >= SUSTAINED_GRADE_WINDOW_M) grade = Math.max(grade, edge.maximumSustainedGradePct ?? 0);
          profile.push({ distanceMeters: distance, elevationMeters: to.elevationMeters ?? NaN });
        }
      }
    }
    if (request.steepestSustainedGradePct && profile.every((point) => Number.isFinite(point.elevationMeters))) {
      grade = Math.max(grade, maximumSustainedGradePct(profile) ?? 0);
    }
    const violations: string[] = [];
    let penalty = 0;
    const bound = (value: number, min: number, max: number, below: string, above: string, scale = 1): void => {
      if (value < min) { violations.push(below); penalty += (min - value) * scale; }
      if (value > max) { violations.push(above); penalty += (value - max) * scale; }
    };
    bound(distance, minimum, maximum, "distance-below-minimum", "distance-above-maximum");
    if (request.elevationGainFeet) bound(gain, request.elevationGainFeet.min * FOOT,
      request.elevationGainFeet.max * FOOT, "gain-below-minimum", "gain-above-maximum", 5);
    if (request.maximumElevationFeet) bound(maximumElevation / FOOT, request.maximumElevationFeet.min,
      request.maximumElevationFeet.max, "maximum-elevation-outside-range", "maximum-elevation-outside-range", 5);
    if (request.steepestSustainedGradePct) bound(grade, request.steepestSustainedGradePct.min,
      request.steepestSustainedGradePct.max, "sustained-grade-outside-range", "sustained-grade-outside-range", 100);
    bound(repeated, 0, repetitionLimit * distance + 1e-9, "", "repeated-trail-above-maximum", 4);
    bound(sharedStem(edges), 0, sharedStemLimit, "", "shared-stem-above-maximum", 4);
    const cycles = Math.max(0, physical.size - nodes.size + 1);
    if (cycles === 0) { violations.push("no-physical-cycle"); penalty += target; }
    if (!request.closedRoute.allowMultiCycle && cycles > 1) {
      violations.push("multiple-cycles-forbidden"); penalty += target * (cycles - 1);
    }
    const score = Math.abs(distance - target) + repeated * 0.5;
    return { edges, id,
      distance, gain, repeated, physical, violations, score, fitness: score + penalty * 3 };
  };
  const empty = evaluate([]);
  const offer = (edges: Arc[]): void => {
    if (stopped()) return;
    edges = trim(edges);
    const id = identity(edges);
    if (seen.has(id) || edges.length === 0) return;
    seen.add(id); candidateCount++;
    const candidate = evaluate(edges, id);
    if (candidate.violations.length === 0) validCandidateCount++;
    archive.push(candidate);

  };

  const shortest = (source: string, reverse: boolean, weights: Map<Arc, number>): Tree => {
    const distance = new Map([[source, 0]]);
    const length = new Map([[source, 0]]);
    const parent = new Map<string, Arc>();
    const heap = new Heap(); heap.push([0, source]);
    while (heap.items.length > 0 && !stopped()) {
      const [cost, node] = heap.pop();
      if (cost !== distance.get(node)) continue;
      expandedStates++;
      for (const arc of (reverse ? incoming : outgoing).get(node) ?? []) {
        const next = reverse ? arc.from : arc.to;
        const nextCost = cost + weights.get(arc)!;
        if (nextCost >= (distance.get(next) ?? Infinity)) continue;
        distance.set(next, nextCost); length.set(next, length.get(node)! + arc.length);
        parent.set(next, arc); heap.push([nextCost, next]);
      }
    }
    return { source, parent, length };
  };
  const path = (tree: Tree, node: string, reverse: boolean): Arc[] | null => {
    const result: Arc[] = [];
    while (node !== tree.source) {
      const arc = tree.parent.get(node);
      if (!arc) return null;
      result.push(arc); node = reverse ? arc.to : arc.from;
    }
    return reverse ? result : result.reverse();
  };

  // The empty walk uses this same move to acquire its first cycle. Equal endpoints
  // insert a nonempty excursion; other spans are shortened, rerouted, or removed.
  for (; moves < 512 && arcs.length > 0 && !stopped(); moves++) {
    const base = moves === 0 || random() < 0.08 || pool.length === 0
      ? empty : pool[Math.floor(random() * Math.min(pool.length, 12))]!;
    const count = base.edges.length;
    let left = Math.floor(random() * (count + 1));
    let right = left;
    if (random() < 0.5) right = left + Math.floor(random() * (count - left + 1));
    if (random() < 0.1) { left = 0; right = count; }
    const from = left === 0 ? root : base.edges[left - 1]!.to;
    const to = right === 0 ? root : base.edges[right - 1]!.to;
    const prefix = base.edges.slice(0, left), suffix = base.edges.slice(right);
    const kept = [...prefix, ...suffix];
    if (from === to && left !== right) offer(kept);
    const used = new Set(kept.map((arc) => arc.key));
    const weights = new Map(arcs.map((arc) => [arc, arc.length *
      (1 + (used.has(arc.key) ? 8 : 0) + (exposure.get(arc.key) ?? 0) * 0.1) * (0.75 + random() * 0.5)]));
    const forward = shortest(from, false, weights);
    const reverse = shortest(to, true, weights);
    const keptLength = kept.reduce((sum, arc) => sum + arc.length, 0);
    const pivots = arcs.map((arc) => ({ arc, distance: keptLength + (forward.length.get(arc.from) ?? Infinity)
      + arc.length + (reverse.length.get(arc.to) ?? Infinity) }))
      .filter(({ distance }) => Number.isFinite(distance) && distance <= maximum * 1.5)
      .sort((a, b) => Math.abs(a.distance - target) - Math.abs(b.distance - target) || a.arc.id.localeCompare(b.arc.id));
    for (const { arc } of pivots.slice(0, 24)) {
      if (stopped()) break;
      const outward = path(forward, arc.from, false), inward = path(reverse, arc.to, true);
      if (outward && inward) offer([...prefix, ...outward, arc, ...inward, ...suffix]);
      exposure.set(arc.key, (exposure.get(arc.key) ?? 0) + 1);
    }
    archive.sort((a, b) => Number(a.violations.length > 0) - Number(b.violations.length > 0)
      || a.fitness - b.fitness || a.id.localeCompare(b.id));
    if (archive.length > 256) archive.length = 256;
    pool = [];
    for (const walk of [...archive].sort((a, b) => a.fitness - b.fitness || a.id.localeCompare(b.id))) {
      if (pool.every((other) => overlap(walk, other) < 0.98)) pool.push(walk);
      if (pool.length >= 24) break;
    }
  }
  if (moves >= 512) reasons.add("unified-move-limit");
  const chosen: Walk[] = [];
  for (const candidate of archive.filter((walk) => walk.violations.length === 0)) {
    if (chosen.every((other) => overlap(candidate, other) <= (options.maximumRouteOverlapFraction ?? 0.8))) chosen.push(candidate);
    if (chosen.length >= request.limit) break;
  }
  const materialize = (walk: Walk): PenalizedClosedRouteCandidate => ({ id: walk.id,
    traversals: walk.edges.flatMap((arc) => arc.chain), distanceMeters: walk.distance,
    elevationGainMeters: walk.gain, repeatedEdgeFraction: walk.repeated / walk.distance,
    score: walk.score, violatedConstraints: walk.violations });
  const near = archive.filter((walk) => walk.violations.length > 0
    && !walk.violations.includes("no-physical-cycle") && !walk.violations.includes("multiple-cycles-forbidden")).slice(0, 5);
  return { candidates: chosen.map(materialize), nearCandidates: near.map(materialize), diagnostics: {
    elapsedMs: Math.max(0, now() - started), expandedStates, candidateCount, validCandidateCount,
    repairAttempts: 0, repairAccepted: 0, assemblyAttempts: 0, assemblyAccepted: 0,
    exhausted: reasons.size > 0, truncationReasons: [...reasons].sort(),
  } };
}
