import { createHash } from 'node:crypto';
import { canonical, compareMetrics, preference, walkKey, type RouteMetrics } from './quality.js';
import type { RouteCandidate, SearchEvent, SearchProgress, SearchQuery, TrailGraph } from '../model.js';
import { DEFAULT_ROAD_LIMITS } from '../model.js';
import type { WorkBudget } from '../work-budget.js';
import { validGradeLimits } from '../grade.js';

type Options = { signal?: AbortSignal; maxExpansions?: number; maxResults?: number; sliceExpansions?: number; budget?: WorkBudget; gradeCheck?: (route: RouteCandidate) => boolean };
type Physical = { trail: number; from: number; to: number; directions: number[]; distance: number; gain: number; road: number; trailDistanceUpper: number };
type Index = { physical: Physical[]; physicalForEdge: Int32Array; incident: number[][]; reverse: Int32Array; starts: number[][]; eligible: number[]; stemRatio: number; zeroRepetitionPossible: boolean; rounding: number; roadBounds: Map<number, Map<number, number>>; roadShortest: Map<number, Map<number, number>>; roadCertificates: Map<string, boolean>; gradeCheck?: Options['gradeCheck'] };

export function validateQuery(query: SearchQuery): void {
  if (query.grades !== undefined && !validGradeLimits(query.grades)) throw new Error('Invalid grade limits');
  for (const range of [query.distance, query.gain]) {
    if (range.length !== 2 || range.some(value => !Number.isFinite(value) || value < 0) || range[0] > range[1]) {
      throw new Error('Search distance and elevation gain need ordered, finite, nonnegative ranges');
    }
  }
  if (query.stem === undefined && query.repetition === undefined) throw new Error('Specify a stem distance or percentage limit');
  if (query.stem !== undefined && (!Number.isFinite(query.stem) || query.stem < 0)) throw new Error('Stem distance must be finite and nonnegative');
  if (query.repetition !== undefined && (!Number.isFinite(query.repetition) || query.repetition < 0 || query.repetition > 1)) {
    throw new Error('Legacy repeated-trail limits must be a fraction between zero and one');
  }
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  if (!Number.isFinite(roads.distance) || roads.distance < 0 || !Number.isFinite(roads.fraction)
    || roads.fraction < 0 || roads.fraction > 1) throw new Error('Road limits need a finite nonnegative distance and a fraction between zero and one');
}
function allowance(value: number | undefined): number {
  if (value === undefined || value === Infinity) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Search allowances must be nonnegative integers');
  return value;
}

function indexGraph(graph: TrailGraph, query: SearchQuery): Index {
  const incident = Array.from({ length: graph.nodes.length }, () => [] as number[]);
  const starts = Array.from({ length: graph.nodes.length }, () => [] as number[]);
  const eligible: number[] = [];
  for (const [index, start] of graph.starts.entries()) {
    if (!graph.nodes[start.node] || !['public', 'unknown'].includes(start.access)) throw new Error(`Invalid start ${start.id}`);
    if (query.includeUnknown || start.access === 'public') { eligible.push(index); starts[start.node]!.push(index); }
  }
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  const allowed = graph.edges.map(edge => (query.includeUnknown || edge.access === 'public')
    && edge.distance <= query.distance[1] && edge.gain <= query.gain[1]
    && (!edge.connector || (edge.distance <= roads.distance && edge.distance / query.distance[1] <= roads.fraction)));
  const directed = new Map<string, number>();
  const trails = new Map<number, number[]>();
  const reverse = new Int32Array(graph.edges.length).fill(-1);
  for (const [index, edge] of graph.edges.entries()) {
    if (!Number.isInteger(edge.from) || !Number.isInteger(edge.to) || !graph.nodes[edge.from] || !graph.nodes[edge.to]
      || !Number.isSafeInteger(edge.trail) || edge.trail < 0 || !Number.isFinite(edge.distance) || edge.distance <= 0
      || !Number.isFinite(edge.gain) || edge.gain < 0 || typeof edge.reverse !== 'boolean' || typeof edge.connector !== 'boolean'
      || !['public', 'unknown'].includes(edge.access)) throw new Error(`Invalid trail edge ${index}`);
    const key = `${edge.trail}:${edge.reverse}`;
    if (directed.has(key)) throw new Error(`Duplicate trail direction ${key}`);
    directed.set(key, index);
    if (allowed[index]) trails.set(edge.trail, [...(trails.get(edge.trail) ?? []), index]);
  }
  for (const [index, edge] of graph.edges.entries()) {
    const back = directed.get(`${edge.trail}:${!edge.reverse}`);
    if (back === undefined) continue;
    const other = graph.edges[back]!;
    if (other.from !== edge.to || other.to !== edge.from || other.connector !== edge.connector) throw new Error(`Mismatched reverse for edge ${index}`);
    if (allowed[index] && allowed[back]) reverse[index] = back;
  }
  const physical: Physical[] = [], physicalForEdge = new Int32Array(graph.edges.length).fill(-1);
  for (const [trail, directions] of [...trails].sort(([a], [b]) => a - b)) {
    const first = graph.edges[directions[0]!]!;
    const item = { trail, from: first.from, to: first.to, directions,
      distance: Math.min(...directions.map(id => Math.floor(graph.edges[id]!.distance))),
      gain: Math.min(...directions.map(id => Math.floor(graph.edges[id]!.gain))),
      road: first.connector ? Math.min(...directions.map(id => Math.floor(graph.edges[id]!.distance))) : 0,
      trailDistanceUpper: first.connector ? 0 : Math.max(...directions.map(id => Math.ceil(graph.edges[id]!.distance))) };
    const index = physical.push(item) - 1;
    for (const id of directions) physicalForEdge[id] = index;
    incident[item.from]!.push(index);
    if (item.to !== item.from) incident[item.to]!.push(index);
  }
  // Every possible approach traverses a reversible physical trail twice. The
  // ratio is an upper bound on outbound/return distance in either orientation.
  let stemRatio = 1, zeroRepetitionPossible = false;
  for (let id = 0; id < graph.edges.length; id++) if (reverse[id]! >= 0) {
    zeroRepetitionPossible ||= graph.edges[id]!.distance / query.distance[1] === 0;
    stemRatio = Math.max(stemRatio, graph.edges[reverse[id]!]!.distance / graph.edges[id]!.distance * (1 + 4 * Number.EPSILON));
  }
  // Positive route sums have at most twice the graph's node count plus a
  // self-loop. This generous gamma guard also covers the products/divisions in
  // the conservative bounds. Unsafe huge bounds simply disable the shortcut.
  const rounding = query.distance[1] * Number.EPSILON * (16 * graph.nodes.length + 64);
  return { physical, physicalForEdge, incident, reverse, starts, eligible, stemRatio, zeroRepetitionPossible, rounding, roadBounds: new Map(), roadShortest: new Map(), roadCertificates: new Map() };
}

function candidate(graph: TrailGraph, query: SearchQuery, start: number, edges: number[], back: number[]): RouteCandidate | undefined {
  let distance = 0, gain = 0, roadDistance = 0, repeatedDistance = 0;
  for (const id of edges) {
    const edge = graph.edges[id]!;
    distance += edge.distance; gain += edge.gain;
    if (edge.connector) roadDistance += edge.distance;
  }
  for (const id of back) repeatedDistance += graph.edges[id]!.distance;
  if (!edges.some(id => !graph.edges[id]!.connector)) return;
  const repetition = repeatedDistance / distance;
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  if (distance < query.distance[0] || distance > query.distance[1] || gain < query.gain[0] || gain > query.gain[1]
    || roadDistance > roads.distance || roadDistance / distance > roads.fraction
    || (query.stem !== undefined && repeatedDistance > query.stem)
    || (query.repetition !== undefined && repetition > query.repetition)) return;
  const route: RouteCandidate = { id: '', start, edges, distance, gain, roadDistance, repetition,
    kind: back.length ? 'lollipop' : 'loop', uncertain: graph.starts[start]!.access === 'unknown'
      || edges.some(id => graph.edges[id]!.access === 'unknown') };
  route.id = `route-${createHash('sha256').update(walkKey(graph, route)).digest('hex').slice(0, 32)}`;
  return route;
}

/** Bounded sparse labels avoid a graph-sized array for every local target. */
function sparseBounds(sources: number[], budget: number, choices: (node: number) => [number, number][], parents?: Map<number, number>): Map<number, number> {
  const labels = new Map<number, number>(), heap: [number, number][] = [];
  const push = (distance: number, node: number) => {
    let at = heap.length; heap.push([distance, node]);
    while (at) { const parent = (at - 1) >>> 1; if (heap[parent]![0] <= distance) break; heap[at] = heap[parent]!; at = parent; }
    heap[at] = [distance, node];
  };
  for (const node of sources) { labels.set(node, 0); push(0, node); }
  while (heap.length) {
    const [distance, node] = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      let at = 0;
      while (at * 2 + 1 < heap.length) {
        let child = at * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]![0] < heap[child]![0]) child++;
        if (heap[child]![0] >= last[0]) break;
        heap[at] = heap[child]!; at = child;
      }
      heap[at] = last;
    }
    if (labels.get(node) !== distance) continue;
    for (const [next, weight] of choices(node)) {
      const following = distance + weight;
      if (following > budget || following >= (labels.get(next) ?? Infinity)) continue;
      labels.set(next, following); parents?.set(next, node); push(following, next);
    }
  }
  return labels;
}
function roadBounds(graph: TrailGraph, index: Index, query: SearchQuery, target: number): Map<number, number> {
  let labels = index.roadBounds.get(target);
  if (!labels) {
    labels = sparseBounds([target], Math.floor((query.roads ?? DEFAULT_ROAD_LIMITS).distance), node => {
      const choices: [number, number][] = [];
      for (const physicalId of index.incident[node]!) for (const id of index.physical[physicalId]!.directions) {
        const edge = graph.edges[id]!;
        if (edge.connector && edge.to === node) choices.push([edge.from, Math.floor(edge.distance)]);
      }
      return choices;
    });
    if (index.roadBounds.size >= 128) index.roadBounds.delete(index.roadBounds.keys().next().value!);
    index.roadBounds.set(target, labels);
  }
  return labels;
}

/** Certify the common case without enumerating alternatives: in a walk with
 * a nonroad main circuit, each road gap between fixed trail steps is simple.
 * Every different gap has a first divergence from the candidate path. If the
 * shortest possible completion after every divergence is strictly longer,
 * each gap is its unique road minimum. Identical gaps give exactly the same
 * ordered road sum; a changed gap exceeds the whole-walk rounding guard.
 * Ambiguous or tied bounds fall back to correlated legal-walk enumeration. */
function uniqueRoadMinimum(graph: TrailGraph, index: Index, query: SearchQuery, route: RouteCandidate): boolean {
  const counts = new Map<number, number>();
  for (const id of route.edges) if (!graph.edges[id]!.connector) counts.set(graph.edges[id]!.trail, (counts.get(graph.edges[id]!.trail) ?? 0) + 1);
  if (![...counts.values()].includes(1)) return false;
  const gap = (from: number, to: number, edges: number[]): boolean => {
    if (!edges.length) return from === to;
    const publicOnly = !route.uncertain;
    const key = `${Number(publicOnly)}:${edges.join(',')}`;
    const known = index.roadCertificates.get(key);
    if (known !== undefined) return known;
    const target = to * 2 + Number(publicOnly);
    let labels = index.roadShortest.get(target);
    if (!labels) {
      const budget = Math.min(query.distance[1], (query.roads ?? DEFAULT_ROAD_LIMITS).distance) + index.rounding;
      labels = sparseBounds([to], budget, node => {
        const choices: [number, number][] = [];
        for (const physicalId of index.incident[node]!) for (const id of index.physical[physicalId]!.directions) {
          const edge = graph.edges[id]!;
          if (edge.connector && edge.to === node && (!publicOnly || edge.access === 'public')) choices.push([edge.from, edge.distance]);
        }
        return choices;
      });
      if (index.roadShortest.size >= 128) index.roadShortest.delete(index.roadShortest.keys().next().value!);
      index.roadShortest.set(target, labels);
    }
    const length = edges.reduce((sum, id) => sum + graph.edges[id]!.distance, 0);
    let prefix = 0, certain = Number.isFinite(index.rounding);
    const visited = new Set([from]);
    for (const id of edges) {
      const edge = graph.edges[id]!;
      if (visited.has(edge.to)) { certain = false; break; }
      visited.add(edge.to);
      for (const physicalId of index.incident[edge.from]!) for (const alternativeId of index.physical[physicalId]!.directions) {
        const alternative = graph.edges[alternativeId]!;
        if (alternativeId === id || !alternative.connector || alternative.from !== edge.from
          || (publicOnly && alternative.access === 'unknown')) continue;
        const lower = prefix + alternative.distance + (labels.get(alternative.to) ?? Infinity);
        if (lower <= length + 8 * index.rounding) { certain = false; break; }
      }
      if (!certain) break;
      prefix += edge.distance;
    }
    if (index.roadCertificates.size >= 2048) index.roadCertificates.delete(index.roadCertificates.keys().next().value!);
    index.roadCertificates.set(key, certain);
    return certain;
  };
  let from = graph.starts[route.start]!.node;
  let roads: number[] = [];
  for (const id of route.edges) {
    const edge = graph.edges[id]!;
    if (edge.connector) roads.push(id);
    else {
      if (!gap(from, edge.from, roads)) return false;
      roads = []; from = edge.to;
    }
  }
  return gap(from, graph.starts[route.start]!.node, roads);
}

/** A shorter road substitution keeps the exact ordered directed trail
 * itinerary. Free choices are exclusively road edges; a first return to a
 * visited prefix node closes its simple circuit, after which the only legal
 * continuation is the exact reversed approach. This searches every legal
 * correlated alternative, including ones below either minimum. */
function* roadDominated(graph: TrailGraph, index: Index, query: SearchQuery, route: RouteCandidate): Generator<undefined, RouteCandidate | undefined> {
  if (!route.roadDistance || uniqueRoadMinimum(graph, index, query, route)) return;
  const itinerary = route.edges.filter(id => !graph.edges[id]!.connector);
  const criteria = { ...query, distance: [0, query.distance[1]] as [number, number], gain: [0, query.gain[1]] as [number, number] };
  const start = graph.starts[route.start]!.node;
  const counts = new Map<number, number>();
  for (const id of itinerary) counts.set(graph.edges[id]!.trail, (counts.get(graph.edges[id]!.trail) ?? 0) + 1);
  const lastMain = itinerary.findLastIndex(id => counts.get(graph.edges[id]!.trail) === 1);
  const blocked = new Map<number, number>(), seenTrails = new Set<number>();
  if (lastMain >= 0) for (const [at, id] of itinerary.entries()) {
    const edge = graph.edges[id]!;
    if (seenTrails.has(edge.trail)) continue;
    seenTrails.add(edge.trail);
    blocked.set(edge.from, Math.max(blocked.get(edge.from) ?? -1, at));
    if (at < lastMain) blocked.set(edge.to, Math.max(blocked.get(edge.to) ?? -1, at));
  }
  const path: number[] = [], nodes = [start];
  const visited = new Map([[start, 0]]);
  const frames = [{ node: start, next: 0, trail: 0, distance: 0, gain: 0, road: 0 }];
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    const destination = graph.edges[itinerary[frame.trail]!] ?.from ?? start;
    const remainingRoad = roadBounds(graph, index, query, destination).get(frame.node) ?? Infinity;
    const choices = index.incident[frame.node]!;
    if (Math.floor(frame.road) + remainingRoad >= route.roadDistance + index.rounding || frame.next === choices.length) {
      frames.pop();
      if (path.length) { path.pop(); visited.delete(nodes.pop()!); }
      continue;
    }
    const physical = index.physical[choices[frame.next++]!]!;
    for (const id of physical.directions) {
      const edge = graph.edges[id]!;
      if (edge.from !== frame.node || (!route.uncertain && edge.access === 'unknown')
        || (!edge.connector && id !== itinerary[frame.trail])) continue;
      const trail = frame.trail + Number(!edge.connector);
      const distance = frame.distance + edge.distance, gain = frame.gain + edge.gain;
      const road = frame.road + (edge.connector ? edge.distance : 0);
      if (distance > query.distance[1] || gain > query.gain[1] || road >= route.roadDistance) continue;
      const earlier = visited.get(edge.to);
      if (earlier !== undefined) {
        if (path.length && graph.edges[path.at(-1)!]!.trail === edge.trail) continue;
        const back: number[] = [];
        let consumed = trail;
        for (let part = earlier - 1; part >= 0; part--) {
          const reverse = index.reverse[path[part]!]!;
          if (reverse < 0) break;
          const step = graph.edges[reverse]!;
          if (!route.uncertain && step.access === 'unknown') break;
          if (!step.connector && reverse !== itinerary[consumed++]) break;
          back.push(reverse);
        }
        if (back.length !== earlier || consumed !== itinerary.length) continue;
        const alternative = candidate(graph, criteria, route.start, [...path, id, ...back], back);
        if (alternative && alternative.roadDistance < route.roadDistance && (!alternative.uncertain || route.uncertain)
          && (!index.gradeCheck || index.gradeCheck(alternative))) return alternative;
      } else {
        // A future first-use trail cannot be reached by returning to a node
        // already in the prefix. Leave its endpoints available until that
        // fixed step; the final core trail may close at an earlier node.
        if (edge.connector && edge.to !== destination && (blocked.get(edge.to) ?? -1) >= frame.trail) continue;
        path.push(id); nodes.push(edge.to); visited.set(edge.to, nodes.length - 1);
        frames.push({ node: edge.to, next: 0, trail, distance, gain, road });
      }
      yield undefined;
    }
    yield undefined;
  }
  return;
}


/** A deterministic discovery pass changes its anchor and positive edge cost,
 * yielding a different shortest-path forest. Every non-tree corridor closes
 * one simple fundamental circuit; this avoids enumerating all simple paths. */
const DISCOVERY = { normal: { passes: 8, circuits: 256, proofs: 128 }, deep: { passes: 24, circuits: 256, proofs: 128 } };
type Tree = { parent: Int32Array; edge: Int32Array; depth: Int32Array; distance: Float64Array;
  gain: Float64Array; road: Float64Array; upper: Float64Array; ancestors: Int32Array[] };
type Forest = { tree: Tree; labels: Float64Array; weights: Float64Array };
type Circuit = { physical: number[]; nodes: number[]; rings: number[][]; key: string; discoveryKey: string;
  upperDistance: number; minDistance: number; minGain: number; minRoad: number };
class Heap {
  private entries: [number, number][] = [];
  get length() { return this.entries.length; }
  push(cost: number, node: number) {
    let at = this.entries.length; this.entries.push([cost, node]);
    while (at) { const parent = (at - 1) >>> 1; if (this.entries[parent]![0] <= cost) break;
      this.entries[at] = this.entries[parent]!; at = parent; }
    this.entries[at] = [cost, node];
  }
  pop(): [number, number] {
    const first = this.entries[0]!, last = this.entries.pop()!;
    if (this.entries.length) {
      let at = 0;
      while (at * 2 + 1 < this.entries.length) {
        let child = at * 2 + 1;
        if (child + 1 < this.entries.length && this.entries[child + 1]![0] < this.entries[child]![0]) child++;
        if (this.entries[child]![0] >= last[0]) break;
        this.entries[at] = this.entries[child]!; at = child;
      }
      this.entries[at] = last;
    }
    return first;
  }
}
function components(index: Index): { nodes: number[]; starts: number[] }[] {
  const seen = new Uint8Array(index.incident.length), result: { nodes: number[]; starts: number[] }[] = [];
  for (let root = 0; root < seen.length; root++) {
    if (seen[root] || !index.incident[root]!.length) continue;
    const nodes = [root]; seen[root] = 1;
    for (let at = 0; at < nodes.length; at++) for (const id of index.incident[nodes[at]!]!) {
      const edge = index.physical[id]!, next = edge.from === nodes[at] ? edge.to : edge.from;
      if (!seen[next]) { seen[next] = 1; nodes.push(next); }
    }
    const starts = nodes.filter(node => index.starts[node]!.length);
    if (starts.length) result.push({ nodes: nodes.sort((a, b) => a - b), starts });
  }
  return result;
}
function anchor(graph: TrailGraph, index: Index, component: { nodes: number[]; starts: number[] }, pass: number): number {
  if (component.nodes.length <= 24) return component.nodes[pass % component.nodes.length]!;
  if (!pass) return component.starts.toSorted((a, b) => {
    const rank = (node: number) => Math.min(...index.starts[node]!.map(id => ({ trailhead: 0, parking: 1, 'road-contact': 2 })[graph.starts[id]!.kind]));
    return rank(a) - rank(b) || a - b;
  })[0]!;
  const axis = (pass - 1) % 4 < 2 ? 0 : 1, sign = pass % 2 ? 1 : -1;
  if (pass <= 4) return component.nodes.reduce((best, node) => sign * graph.nodes[node]![axis]! < sign * graph.nodes[best]![axis]! ? node : best);
  return component.nodes[Math.floor(((pass * 0.6180339887498949) % 1) * component.nodes.length)]!;
}
const jitter = (trail: number, pass: number) => {
  if (!pass) return 1;
  let value = Math.imul(trail ^ Math.imul(pass, 0x9e3779b9), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0xc2b2ae35);
  return 0.8 + ((value ^ (value >>> 16)) >>> 0) / 2 ** 32 * 0.4;
};
function createForest(nodes: number, edges: number): Forest {
  const parent = new Int32Array(nodes), ancestors = [parent];
  for (let level = 1; 2 ** level <= nodes; level++) ancestors.push(new Int32Array(nodes));
  return { labels: new Float64Array(nodes), weights: new Float64Array(edges), tree: {
    parent, edge: new Int32Array(nodes), depth: new Int32Array(nodes), distance: new Float64Array(nodes),
    gain: new Float64Array(nodes), road: new Float64Array(nodes), upper: new Float64Array(nodes), ancestors,
  } };
}
function* forest(graph: TrailGraph, index: Index, roots: number[], pass: number, workspace: Forest): Generator<undefined, Tree> {
  const n = graph.nodes.length, { labels, weights, tree } = workspace, heap = new Heap();
  const { parent, edge, depth, distance, gain, road, upper, ancestors } = tree;
  labels.fill(Infinity); parent.fill(-1); edge.fill(-1); depth.fill(0);
  distance.fill(0); gain.fill(0); road.fill(0); upper.fill(0);
  const uphill = [0, 2, 8, 0][pass % 4]!, pavement = pass % 4 === 3 ? 100 : 12;
  for (const [id, physical] of index.physical.entries()) {
    let minimum = Infinity;
    for (const arc of physical.directions) {
      const item = graph.edges[arc]!;
      minimum = Math.min(minimum, item.distance + uphill * item.gain + (item.connector ? pavement * item.distance : 0));
    }
    weights[id] = minimum * jitter(physical.trail, pass);
    yield undefined;
  }
  for (const root of roots) { labels[root] = 0; heap.push(0, root); }
  while (heap.length) {
    const [cost, node] = heap.pop();
    if (cost !== labels[node]) continue;
    for (const id of index.incident[node]!) {
      const physical = index.physical[id]!, next = physical.from === node ? physical.to : physical.from;
      if (next === node) continue;
      const following = cost + weights[id]!;
      if (following < labels[next]!) {
        labels[next] = following; parent[next] = node; edge[next] = id; depth[next] = depth[node]! + 1;
        distance[next] = distance[node]! + physical.distance;
        gain[next] = gain[node]! + physical.gain; road[next] = road[node]! + physical.road;
        upper[next] = upper[node]! + physical.trailDistanceUpper;
        heap.push(following, next);
      }
      yield undefined;
    }
  }
  for (let level = 1; level < ancestors.length; level++) {
    const previous = ancestors[level - 1]!, current = ancestors[level]!.fill(-1);
    for (let node = 0; node < n; node++) {
      if (previous[node]! >= 0) current[node] = previous[previous[node]!]!;
      if (node % 1024 === 0) yield undefined;
    }
  }
  return tree;
}
function ancestor(tree: Tree, left: number, right: number): number {
  if (tree.depth[left]! < tree.depth[right]!) [left, right] = [right, left];
  let difference = tree.depth[left]! - tree.depth[right]!;
  for (let level = 0; difference; level++, difference >>>= 1) if (difference & 1) left = tree.ancestors[level]![left]!;
  if (left === right) return left;
  for (let level = tree.ancestors.length - 1; level >= 0; level--) if (tree.ancestors[level]![left] !== tree.ancestors[level]![right]) {
    left = tree.ancestors[level]![left]!; right = tree.ancestors[level]![right]!;
  }
  return tree.parent[left]!;
}
function circuit(graph: TrailGraph, index: Index, tree: Tree, closing: number): Circuit | undefined {
  const physical = index.physical[closing]!, common = ancestor(tree, physical.from, physical.to);
  if (common < 0) return;
  const first: number[] = [], last: number[] = [];
  for (let node = physical.from; node !== common; node = tree.parent[node]!) first.push(tree.edge[node]!);
  for (let node = physical.to; node !== common; node = tree.parent[node]!) last.push(tree.edge[node]!);
  const parts = [...first, ...last.toReversed(), closing];
  return makeCircuit(graph, index, parts, physical.from);
}
function makeCircuit(graph: TrailGraph, index: Index, parts: number[], start: number): Circuit | undefined {
  let node = start;
  const nodes: number[] = [], forward: number[] = [], backward: number[] = [];
  let legalForward = true, legalBackward = true;
  for (const id of parts) {
    nodes.push(node);
    const item = index.physical[id]!, next = item.from === node ? item.to : item.from;
    const out = item.directions.find(arc => graph.edges[arc]!.from === node && graph.edges[arc]!.to === next);
    const back = item.directions.find(arc => graph.edges[arc]!.from === next && graph.edges[arc]!.to === node && arc !== out);
    if (out === undefined) legalForward = false; else forward.push(out);
    if (back === undefined) legalBackward = false; else backward.unshift(back);
    node = next;
  }
  if (node !== start || new Set(parts).size !== parts.length || new Set(nodes).size !== nodes.length || (!legalForward && !legalBackward)) return;
  const order = canonical(parts.map(id => index.physical[id]!.trail));
  const reversed = [order[0]!, ...order.slice(1).toReversed()];
  // Discovery's text-based tie order predates the shared numeric identity.
  // Preserve it so the bounded local shortlist selects the same circuits.
  const discoveryKey = JSON.stringify(order.join(',') < reversed.join(',') ? order : reversed);
  const rings = [legalForward ? forward : undefined, legalBackward ? backward : undefined].filter((ring): ring is number[] => !!ring);
  const min = (metric: (id: number) => number) => Math.min(...rings.map(ring => ring.reduce((sum, id) => sum + metric(id), 0)));
  return { physical: parts, nodes, rings, key: JSON.stringify(order), discoveryKey,
    upperDistance: Math.max(...rings.map(ring => ring.reduce((sum, id) => sum + Math.ceil(graph.edges[id]!.distance), 0))),
    minDistance: min(id => Math.floor(graph.edges[id]!.distance)), minGain: min(id => Math.floor(graph.edges[id]!.gain)),
    minRoad: min(id => graph.edges[id]!.connector ? Math.floor(graph.edges[id]!.distance) : 0) };
}
/** Balance circuit trials between disconnected components and distance bands.
 * This is a discovery budget, never a limit on saved hikes or qualifying starts. */
function* proposals(graph: TrailGraph, index: Index, query: SearchQuery, tree: Tree, groups: { nodes: number[] }[]): Generator<undefined, number[]> {
  const component = new Int32Array(graph.nodes.length).fill(-1);
  groups.forEach((group, id) => { for (const node of group.nodes) component[node] = id; });
  const queues = new Map<string, { id: number; score: number }[]>(), roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  const denominator = 1 - (index.stemRatio + 1) * (query.repetition ?? 0) - roads.fraction;
  const minimumTrails = query.stem === undefined ? query.distance[0] * denominator
    : query.distance[0] * (1 - roads.fraction) - stemDistanceBudget(index, query, query.distance[1]);
  const desired = (query.distance[0] + query.distance[1]) / 2;
  for (const [id, edge] of index.physical.entries()) {
    if (component[edge.from]! < 0 || tree.edge[edge.from] === id || tree.edge[edge.to] === id) continue;
    const root = ancestor(tree, edge.from, edge.to);
    if (root < 0) continue;
    const metric = (labels: Float64Array, extra: number) => labels[edge.from]! + labels[edge.to]! - 2 * labels[root]! + extra;
    const distance = metric(tree.distance, edge.distance), gain = metric(tree.gain, edge.gain), road = metric(tree.road, edge.road);
    const trails = metric(tree.upper, edge.trailDistanceUpper);
    if (distance > query.distance[1] + index.rounding || road > roads.distance + index.rounding
      || gain > query.gain[1] + Math.abs(query.gain[1]) * Number.EPSILON * (16 * graph.nodes.length + 64)
      || (denominator > 0 && trails + index.rounding < minimumTrails - index.rounding)) continue;
    const band = Math.min(3, Math.max(0, Math.floor(distance / Math.max(desired, 1) * 3)));
    const key = `${component[edge.from]}:${band}`;
    const score = Math.abs(distance - desired) / Math.max(desired, 1) + road / Math.max(distance, 1)
      + Math.max(0, query.gain[0] - gain) / Math.max(query.gain[1], 1) * 0.3;
    const queue = queues.get(key) ?? []; queue.push({ id, score }); queues.set(key, queue);
    yield undefined;
  }
  for (const queue of queues.values()) queue.sort((a, b) => a.score - b.score || a.id - b.id);
  const result: number[] = [], positions = new Map<string, number>();
  const total = [...queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  while (result.length < total) {
    for (const [key, queue] of queues) {
      const position = positions.get(key) ?? 0;
      if (position < queue.length) { result.push(queue[position]!.id); positions.set(key, position + 1); }
    }
  }
  return result;
}
/** A connection tree uses reversible corridors and stops at its first circuit
 * contact. Its paths are simple and cannot intersect another circuit part. */
/** A small local detour/shortcut pool changes one corridor at a time. Its
 * interior stays outside the original simple path; full-walk checks follow. */
function alternatives(index: Index, parts: number[], nodes: number[], forbidden: Set<number>): number[][] {
  const result: number[][] = [];
  for (let at = 0; at < parts.length; at++) {
    const from = nodes[at]!, to = nodes[at + 1]!;
    for (const first of index.incident[from]!) {
      if (first === parts[at]) continue;
      const edge = index.physical[first]!, middle = edge.from === from ? edge.to : edge.from;
      if (middle === to) result.push([...parts.slice(0, at), first, ...parts.slice(at + 1)]);
      else if (!forbidden.has(middle)) for (const second of index.incident[middle]!) {
        const other = index.physical[second]!, end = other.from === middle ? other.to : other.from;
        if (second !== first && end === to) result.push([...parts.slice(0, at), first, second, ...parts.slice(at + 1)]);
      }
    }
  }
  return result;
}
function interest(graph: TrailGraph, query: SearchQuery, edges: number[], back: number[] = []): number {
  const distance = edges.reduce((sum, id) => sum + graph.edges[id]!.distance, 0);
  const gain = edges.reduce((sum, id) => sum + graph.edges[id]!.gain, 0);
  const violation = (value: number, range: [number, number]) => Math.max(range[0] - value, value - range[1], 0) / Math.max(range[1], 1);
  const roads = edges.reduce((sum, id) => sum + (graph.edges[id]!.connector ? graph.edges[id]!.distance : 0), 0);
  const repeatedDistance = back.reduce((sum, id) => sum + graph.edges[id]!.distance, 0);
  const stemViolation = Math.max(
    Math.max(0, repeatedDistance / distance - (query.repetition ?? 1)),
    Math.max(0, repeatedDistance - (query.stem ?? Infinity)) / Math.max(query.distance[1], 1));
  return violation(distance, query.distance) + violation(gain, query.gain)
    + stemViolation + roads / Math.max(distance, 1) * 0.001;
}
function localCircuits(graph: TrailGraph, index: Index, query: SearchQuery, core: Circuit): Circuit[] {
  const nodes = [...core.nodes, core.nodes[0]!], variants = alternatives(index, core.physical, nodes, new Set(core.nodes));
  const positions = new Map(core.nodes.map((node, at) => [node, at]));
  let work = 0;
  // A short branch can replace either side of the main circuit. Searching
  // only its small neighborhood finds substantial alternate trail branches
  // without enumerating arbitrary winding circuits throughout the graph.
  for (const [at, source] of core.nodes.entries()) {
    const pending = [{ node: source, path: [] as number[], visited: new Set([source]) }];
    for (let next = 0; next < pending.length && work < 256; next++) {
      const prefix = pending[next]!;
      for (const id of index.incident[prefix.node]!) {
        if (++work > 256) break;
        if (core.physical.includes(id) || prefix.path.includes(id)) continue;
        const edge = index.physical[id]!, target = edge.from === prefix.node ? edge.to : edge.from;
        if (prefix.visited.has(target)) continue;
        const path = [...prefix.path, id], contact = positions.get(target);
        if (contact !== undefined) {
          const arc = contact < at ? core.physical.slice(contact, at) : [...core.physical.slice(contact), ...core.physical.slice(0, at)];
          const other = at < contact ? core.physical.slice(at, contact) : [...core.physical.slice(at), ...core.physical.slice(0, contact)];
          const make = (parts: number[]) => {
            const found = makeCircuit(graph, index, parts, source);
            if (found) variants.push(found.physical);
          };
          make([...path, ...arc]); make([...path, ...other.toReversed()]);
        } else if (path.length < 5) pending.push({ node: target, path, visited: new Set([...prefix.visited, target]) });
      }
    }
    if (work >= 256) break;
  }
  const unique = new Map<string, Circuit>();
  for (const parts of variants) {
    // Detour variants may begin at a different contact; reconstruct from an
    // endpoint that makes their cyclic physical order continuous.
    const first = index.physical[parts[0]!]!;
    const found = makeCircuit(graph, index, parts, first.from) ?? makeCircuit(graph, index, parts, first.to);
    if (found && found.key !== core.key) unique.set(found.key, found);
  }
  return [...unique.values()].map(core => ({ core, score: Math.min(...core.rings.map(ring => interest(graph, query, ring))) }))
    .sort((a, b) => a.score - b.score || a.core.discoveryKey.localeCompare(b.core.discoveryKey)).slice(0, 4).map(item => item.core);
}

/** Both approach traversals satisfy F + B <= (k + 1) B. Absolute searches
 * bound B directly; immutable legacy searches use their recorded B / D limit. */
function stemDistanceBudget(index: Index, query: SearchQuery, ceiling: number): number {
  if (query.stem === 0) return 0;
  if (!Number.isFinite(index.stemRatio)) return Infinity;
  return (index.stemRatio + 1) * Math.min(query.stem ?? Infinity, (query.repetition ?? 1) * ceiling);
}

/** Integer upper core length plus a generous ordered-sum guard makes this
 * ceiling independent of start rotation. For a reversible stem F <= k B,
 * and B / D <= r gives D <= C / (1-(k+1)r). Infinite/unsafe bounds disable
 * the shortcut; they never change final feasibility. */
function distanceCeiling(graph: TrailGraph, index: Index, query: SearchQuery, core: Circuit): number {
  const upper = core.upperDistance;
  if (query.stem !== undefined) {
    if (!Number.isSafeInteger(upper) || !Number.isFinite(index.rounding)) return query.distance[1];
    return Math.min(query.distance[1], upper + stemDistanceBudget(index, query, query.distance[1]) + 2 * index.rounding);
  }
  const denominator = 1 - (index.stemRatio + 1) * query.repetition! - 16 * Number.EPSILON;
  if (!Number.isSafeInteger(upper) || !Number.isFinite(index.rounding) || denominator <= 0) return query.distance[1];
  return Math.min(query.distance[1], (upper + index.rounding) / denominator + index.rounding);
}
function* connections(graph: TrailGraph, index: Index, query: SearchQuery, core: Circuit, mode: number, contact?: number): Generator<undefined, Map<number, number>> {
  const uphill = [0, 2, 8, 0][mode]!, pavement = 12;
  const knownOnly = mode === 3, labels = new Map<number, number>(), parents = new Map<number, number>(), heap = new Heap();
  const coreNodes = new Set(core.nodes);
  const ceiling = distanceCeiling(graph, index, query, core);
  const distanceBudget = Math.max(0, Math.min(query.distance[1] - core.minDistance,
    stemDistanceBudget(index, query, ceiling)) + index.rounding);
  const gainBudget = Number.isSafeInteger(Math.floor(query.gain[1])) ? query.gain[1] - core.minGain : Infinity;
  const roadBudget = (query.roads ?? DEFAULT_ROAD_LIMITS).distance - core.minRoad;
  const returnBudget = query.stem === undefined ? Infinity : query.stem + index.rounding;
  const facts = new Map<number, [number, number, number, number]>();
  for (const node of contact === undefined ? core.nodes : [contact]) { labels.set(node, 0); facts.set(node, [0, 0, 0, 0]); heap.push(0, node); }
  while (heap.length) {
    const [cost, node] = heap.pop();
    if (labels.get(node) !== cost) continue;
    for (const physicalId of index.incident[node]!) {
      const physical = index.physical[physicalId]!, next = physical.from === node ? physical.to : physical.from;
      if (coreNodes.has(next) || physical.directions.length !== 2) continue;
      const out = physical.directions.find(id => graph.edges[id]!.from === node)!;
      if (out === undefined || index.reverse[out]! < 0) continue;
      const parts = [graph.edges[out]!, graph.edges[index.reverse[out]!]!];
      if (knownOnly && parts.some(edge => edge.access === 'unknown')) continue;
      const previous = facts.get(node)!, totals = [...previous] as [number, number, number, number];
      // The tree grows from the circuit toward the start, along the actual
      // return direction. Flooring keeps this a conservative pruning bound.
      totals[3] += Math.floor(graph.edges[out]!.distance);
      let weight = 0;
      for (const edge of parts) {
        totals[0] += Math.floor(edge.distance); totals[1] += Math.floor(edge.gain);
        if (edge.connector) totals[2] += Math.floor(edge.distance);
        weight += edge.distance + uphill * edge.gain + (edge.connector ? pavement * edge.distance : 0);
      }
      const following = cost + weight;
      if (totals[0] <= distanceBudget && totals[1] <= gainBudget && totals[2] <= roadBudget + index.rounding
        && totals[3] <= returnBudget && following < (labels.get(next) ?? Infinity)) {
        labels.set(next, following); facts.set(next, totals); parents.set(next, index.reverse[out]!); heap.push(following, next);
      }
      yield undefined;
    }
  }
  return parents;
}
function* witnesses(graph: TrailGraph, index: Index, query: SearchQuery, core: Circuit, modes: number[], proofBudget: number): Generator<RouteCandidate | undefined> {
  if (distanceCeiling(graph, index, query, core) + index.rounding < query.distance[0]) return;
  const emitted = new Set<string>(), best = new Map<number, RouteMetrics>(), coreNodes = new Set(core.nodes);
  let preferred: RouteCandidate | undefined;
  const rings = core.rings.map(ring => {
    const anchor = Math.min(...ring.map(id => graph.edges[id]!.trail));
    return { ring, direction: Number(graph.edges[ring.find(id => graph.edges[id]!.trail === anchor)!]!.reverse),
      positions: new Map(ring.map((id, at) => [graph.edges[id]!.from, at])) };
  });
  const hasStems = query.stem === undefined ? query.repetition !== 0 || index.zeroRepetitionPossible : query.stem !== 0;
  if (!hasStems) modes = modes.slice(0, 1);
  const plans = modes.map(mode => ({ mode, contact: undefined as number | undefined }));
  // Different circuit contacts remain useful when the nearest one cannot
  // supply the requested length. Each connection forbids all other contacts.
  if (hasStems && modes.includes(0)) for (const position of [...new Set([0, Math.floor(core.nodes.length / 2), Math.floor(core.nodes.length / 4), Math.floor(core.nodes.length * 3 / 4)])]) {
    plans.push({ mode: 0, contact: core.nodes[position] });
  }
  const verify = function* (start: number, outward: number[], ring: number[], direction: number): Generator<undefined> {
    const back = outward.toReversed().map(id => index.reverse[id]!);
    const key = start * 2 + direction;
    const route = candidate(graph, query, start, [...outward, ...ring, ...back], back);
    if (!route || emitted.has(route.id)) return;
    emitted.add(route.id);
    const previous = best.get(key);
    if (previous && compareMetrics(route, previous) > 0) return;
    if (index.gradeCheck && !index.gradeCheck(route)) return;
    const proof = roadDominated(graph, index, query, route);
    let result = proof.next(), work = 0;
    while (!result.done && work++ < proofBudget) { yield undefined; result = proof.next(); }
    if (result.done && !result.value) {
      // Only compact feasibility/ranking facts survive for other starts. Keep
      // one full walk for the circuit; tied walks still receive a road proof.
      best.set(key, { uncertain: route.uncertain, roadDistance: route.roadDistance, repetition: route.repetition, distance: route.distance });
      if (!preferred || preference(graph, route, preferred) < 0) preferred = route;
    }
    else proof.return(undefined);
  };
  for (const { mode, contact } of plans) {
    const parents = hasStems ? yield* connections(graph, index, query, core, mode, contact) : new Map<number, number>();
    for (const start of index.eligible) {
      let node = graph.starts[start]!.node;
      if (!coreNodes.has(node) && !parents.has(node)) continue;
      const outward: number[] = [];
      while (!coreNodes.has(node)) { const id = parents.get(node)!; outward.push(id); node = graph.edges[id]!.to; }
      for (const { ring, direction, positions } of rings) {
        const position = positions.get(node)!;
        const rotated = [...ring.slice(position), ...ring.slice(0, position)];
        yield* verify(start, outward, rotated, direction);
        if (!outward.length || contact !== undefined || mode !== modes[0] || best.has(start * 2 + direction)) continue;
        const pathNodes = [graph.starts[start]!.node, ...outward.map(id => graph.edges[id]!.to)];
        const physical = outward.map(id => index.physicalForEdge[id]!);
        const paths = alternatives(index, physical, pathNodes, new Set([...core.nodes, ...pathNodes])).map(parts => {
          let current = pathNodes[0]!, valid = true;
          const directed: number[] = [];
          for (const item of parts) {
            const next = index.physical[item]!.directions.find(id => graph.edges[id]!.from === current && index.reverse[id]! >= 0);
            if (next === undefined) { valid = false; break; }
            directed.push(next); current = graph.edges[next]!.to;
          }
          return valid ? directed : undefined;
        }).filter((path): path is number[] => !!path);
        const ranked = paths.map(path => {
          const back = path.toReversed().map(id => index.reverse[id]!);
          return { path, score: interest(graph, query, [...path, ...rotated, ...back], back), key: path.join(',') };
        }).sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
        for (const { path } of ranked.slice(0, 4)) yield* verify(start, path, rotated, direction);
      }
      yield undefined;
    }
  }
  if (preferred) yield preferred;
}

/** Private, deterministic bounded discovery. Completion means that every
 * planned pass and sensible start connection finished, not exhaustive absence.
 * All emitted walks pass strict ordered metrics and a road-minimum proof. */
export async function* search(graph: TrailGraph, query: SearchQuery, options: Options = {}): AsyncGenerator<SearchEvent> {
  validateQuery(query);
  if (query.grades && !options.gradeCheck) throw new Error('Grade-constrained search requires elevation geometry');
  query = { ...query, sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], roads: { ...(query.roads ?? DEFAULT_ROAD_LIMITS) } };
  const plan = DISCOVERY[query.effort ?? 'normal'];
  if (!plan) throw new Error('Unknown discovery effort');
  const maximum = allowance(options.maxExpansions), maxResults = allowance(options.maxResults), slice = options.sliceExpansions ?? 8192;
  if (!Number.isSafeInteger(slice) || slice < 1) throw new Error('Search slices must be positive integers');
  const started = Date.now(), progress: SearchProgress = { totalStarts: graph.starts.filter(start => query.includeUnknown || start.access === 'public').length,
    attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0, totalSearchPoints: plan.passes * (plan.circuits + 1), completedSearchPoints: 0 };
  const snapshot = () => ({ ...progress, elapsedMs: Date.now() - started });
  yield { type: 'progress', progress: snapshot() };
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (options.signal?.aborted) { yield { type: 'done', status: 'stopped', progress: snapshot(), reason: 'Search stopped' }; return; }
  const index = indexGraph(graph, query), groups = components(index), seen = new Set<string>();
  if (query.grades) index.gradeCheck = options.gradeCheck;
  const workspace = createForest(graph.nodes.length, index.physical.length);
  await options.budget?.checkpoint();
  progress.totalStarts = progress.attemptedStarts = index.eligible.length;
  let results = 0, yieldedAt = performance.now();
  const visit = function* (): Generator<RouteCandidate | undefined> {
    if (!index.eligible.length) return;
    for (let pass = 0; pass < plan.passes; pass++) {
      const roots = groups.map(group => anchor(graph, index, group, pass));
      const tree = yield* forest(graph, index, roots, pass, workspace), choices = yield* proposals(graph, index, query, tree, groups);
      progress.completedSearchPoints = pass * (plan.circuits + 1) + 1;
      let trials = 0, turn = 0;
      const pending: { core: Circuit; depth: number }[] = [];
      for (let choice = 0; choice < choices.length || pending.length; ) {
        // Keep most trials for new main circuits. Local variants must not
        // consume the pass before geographically distinct seeds are tried.
        const item = pending.length && (choice >= choices.length || turn++ % 5 === 4)
          ? pending.shift()! : { core: circuit(graph, index, tree, choices[choice++]!), depth: 0 };
        const core = item.core;
        if (!core || seen.has(core.key)) continue;
        if (trials++ >= plan.circuits) break;
        seen.add(core.key);
        if (item.depth < 2) for (const variant of localCircuits(graph, index, query, core)) pending.push({ core: variant, depth: item.depth + 1 });
        yield* witnesses(graph, index, query, core, [0, 1, 2, 3], plan.proofs);
        progress.completedSearchPoints = pass * (plan.circuits + 1) + 1 + trials;
        yield undefined;
      }
      progress.completedSearchPoints = (pass + 1) * (plan.circuits + 1);
      yield undefined;
    }

  };
  for (const route of visit()) {
    if (options.signal?.aborted) { yield { type: 'done', status: 'stopped', progress: snapshot(), reason: 'Search stopped' }; return; }
    if (progress.expansions >= maximum || results >= maxResults) {
      yield { type: 'done', status: 'limited', progress: snapshot(), reason: results >= maxResults ? 'Result allowance reached; discovery is unfinished' : 'Expansion allowance reached; discovery is unfinished' }; return;
    }
    progress.expansions++;
    if (route) { results++; yield { type: 'route', route }; }
    if (progress.expansions % slice === 0 || performance.now() - yieldedAt >= 8) {
      yield { type: 'progress', progress: snapshot() };
      if (options.budget) await options.budget.checkpoint();
      else await new Promise<void>(resolve => setTimeout(resolve, 0));
      yieldedAt = performance.now();
    }
  }
  progress.completedStarts = progress.totalStarts; progress.completedSearchPoints = progress.totalSearchPoints;
  await options.budget?.checkpoint();
  yield { type: 'done', status: 'complete', progress: snapshot() };
}
