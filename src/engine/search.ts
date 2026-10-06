import type { RouteCandidate, SearchEvent, SearchProgress, SearchQuery, TrailGraph } from '../model.js';
import { DEFAULT_ROAD_LIMITS } from '../model.js';
import { createCircuitBounds } from './circuit-bounds.js';

type Options = { signal?: AbortSignal; maxExpansions?: number; maxResults?: number; sliceExpansions?: number; prefer?: (a: RouteCandidate, b: RouteCandidate) => number };
type Physical = { trail: number; from: number; to: number; directions: number[]; distance: number; gain: number; road: number; trailDistanceUpper: number };
type Index = { physical: Physical[]; incident: number[][]; reverse: Int32Array; starts: number[][]; eligible: number[]; approachCost: number[][]; startBounds?: (Float64Array | undefined)[]; stemRatio: number; rounding: number; roadBounds: Map<number, Map<number, number>>; roadShortest: Map<number, Map<number, number>>; roadCertificates: Map<string, boolean> };

export function validateQuery(query: SearchQuery): void {
  for (const range of [query.distance, query.gain]) {
    if (range.length !== 2 || range.some(value => !Number.isFinite(value) || value < 0) || range[0] > range[1]) {
      throw new Error('Search distance and gain need ordered, finite, nonnegative ranges');
    }
  }
  if (!Number.isFinite(query.repetition) || query.repetition < 0 || query.repetition > 1) {
    throw new Error('Repeated trail must be a fraction between zero and one');
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
    if (query.includeUnknown || edge.access === 'public') trails.set(edge.trail, [...(trails.get(edge.trail) ?? []), index]);
  }
  for (const [index, edge] of graph.edges.entries()) {
    const back = directed.get(`${edge.trail}:${!edge.reverse}`);
    if (back === undefined) continue;
    const other = graph.edges[back]!;
    if (other.from !== edge.to || other.to !== edge.from || other.connector !== edge.connector) throw new Error(`Mismatched reverse for edge ${index}`);
    if (query.includeUnknown || other.access === 'public') reverse[index] = back;
  }
  const physical: Physical[] = [];
  for (const [trail, directions] of [...trails].sort(([a], [b]) => a - b)) {
    const first = graph.edges[directions[0]!]!;
    const item = { trail, from: first.from, to: first.to, directions,
      distance: Math.min(...directions.map(id => Math.floor(graph.edges[id]!.distance))),
      gain: Math.min(...directions.map(id => Math.floor(graph.edges[id]!.gain))),
      road: first.connector ? Math.min(...directions.map(id => Math.floor(graph.edges[id]!.distance))) : 0,
      trailDistanceUpper: first.connector ? 0 : Math.max(...directions.map(id => Math.ceil(graph.edges[id]!.distance))) };
    const index = physical.push(item) - 1;
    incident[item.from]!.push(index);
    if (item.to !== item.from) incident[item.to]!.push(index);
  }
  const approachCost = physical.map(edge => {
    const parts = edge.directions.map(id => graph.edges[id]!);
    return [parts.reduce((sum, edge) => sum + Math.floor(edge.distance), 0),
      parts.reduce((sum, edge) => sum + Math.floor(edge.gain), 0),
      parts.reduce((sum, edge) => sum + (edge.connector ? Math.floor(edge.distance) : 0), 0)];
  });
  // Every possible approach traverses a reversible physical trail twice. The
  // ratio is an upper bound on outbound/return distance in either orientation.
  let stemRatio = 1;
  for (let id = 0; id < graph.edges.length; id++) if (reverse[id]! >= 0) {
    stemRatio = Math.max(stemRatio, graph.edges[reverse[id]!]!.distance / graph.edges[id]!.distance * (1 + 4 * Number.EPSILON));
  }
  // Positive route sums have at most twice the graph's node count plus a
  // self-loop. This generous gamma guard also covers the products/divisions in
  // the conservative bounds. Unsafe huge bounds simply disable the shortcut.
  const rounding = query.distance[1] * Number.EPSILON * (16 * graph.nodes.length + 64);
  return { physical, incident, reverse, starts, eligible, approachCost, stemRatio, rounding, roadBounds: new Map(), roadShortest: new Map(), roadCertificates: new Map() };
}

/** Iterative Tarjan decomposition keeps parallel corridors as different edges.
 * Bridges remain in the index for approaches; only cyclic blocks are returned. */
function blocks(index: Index): number[][] {
  const { physical, incident } = index;
  const entered = new Int32Array(incident.length);
  const low = new Int32Array(incident.length);
  const pending: number[] = [];
  const result: number[][] = [];
  let clock = 0;
  for (let root = 0; root < incident.length; root++) {
    if (entered[root]) continue;
    entered[root] = low[root] = ++clock;
    const frames = [{ node: root, parent: -1, next: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      if (frame.next === incident[frame.node]!.length) {
        frames.pop();
        if (frame.parent >= 0) {
          const edge = physical[frame.parent]!;
          const parent = edge.from === frame.node ? edge.to : edge.from;
          low[parent] = Math.min(low[parent]!, low[frame.node]!);
          if (low[frame.node]! >= entered[parent]!) {
            const block: number[] = [];
            let last: number;
            do { last = pending.pop()!; block.push(last); } while (last !== frame.parent);
            if (block.length > 1) result.push(block.sort((a, b) => a - b));
          }
        }
        continue;
      }
      const id = incident[frame.node]![frame.next++]!;
      const edge = physical[id]!;
      if (edge.from === edge.to) { result.push([id]); continue; }
      if (id === frame.parent) continue;
      const next = edge.from === frame.node ? edge.to : edge.from;
      if (!entered[next]) {
        pending.push(id); entered[next] = low[next] = ++clock;
        frames.push({ node: next, parent: id, next: 0 });
      } else if (entered[next]! < entered[frame.node]!) {
        pending.push(id); low[frame.node] = Math.min(low[frame.node]!, entered[next]!);
      }
    }
  }
  return result.sort((a, b) => a[0]! - b[0]!);
}

/** Whole-meter path labels underestimate every final route-order sum. A
 * query beyond safe integer labels simply runs without this optimization. */
function lowerBounds(index: Index, sources: number[], limit: number, metric: 0 | 1 | 2,
  choices: (node: number) => number[], reversible = false, reuse?: Float64Array, parents?: Int32Array, directedCost?: (id: number, node: number) => number | undefined): Float64Array | undefined {
  const budget = Math.floor(limit);
  if (!Number.isSafeInteger(budget)) return;
  const labels = (reuse ?? new Float64Array(index.incident.length)).fill(Infinity);
  parents?.fill(-1);
  const heap: [number, number][] = [];
  const push = (distance: number, node: number) => {
    let at = heap.length;
    heap.push([distance, node]);
    while (at) {
      const parent = (at - 1) >>> 1;
      if (heap[parent]![0] <= distance) break;
      heap[at] = heap[parent]!; at = parent;
    }
    heap[at] = [distance, node];
  };
  for (const node of sources) if (labels[node] !== 0) { labels[node] = 0; push(0, node); }
  while (heap.length) {
    const [distance, node] = heap[0]!;
    const last = heap.pop()!;
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
    if (distance !== labels[node]) continue;
    for (const id of choices(node)) {
      const edge = index.physical[id]!;
      if (reversible && edge.directions.length !== 2) continue;
      const next = edge.from === node ? edge.to : edge.from;
      const weight = directedCost ? directedCost(id, node) : reversible ? index.approachCost[id]![metric]! : [edge.distance, edge.gain, edge.road][metric]!;
      if (weight === undefined || weight > budget - distance) continue;
      const candidate = distance + weight;
      if (candidate < labels[next]!) { labels[next] = candidate; if (parents) parents[next] = node; push(candidate, next); }
    }
  }
  return labels;
}

/** Once a static return witness crosses the prefix, search the residual
 * graph. A* uses the original conservative labels; visited prefix nodes and
 * already-used root corridors cannot certify a legal closing path. */
function residualReturn(index: Index, adjacency: Map<number, number[]>, root: number, current: number,
  firstEdge: number, visited: Set<number>, labels: Float64Array, budget: number): boolean {
  const distances = new Map([[current, 0]]);
  const heap: [number, number, number][] = [];
  const push = (distance: number, node: number) => {
    const priority = distance + labels[node]!;
    let at = heap.length;
    heap.push([priority, node, distance]);
    while (at) {
      const parent = (at - 1) >>> 1;
      if (heap[parent]![0] <= priority) break;
      heap[at] = heap[parent]!; at = parent;
    }
    heap[at] = [priority, node, distance];
  };
  push(0, current);
  while (heap.length) {
    const [, node, distance] = heap[0]!;
    const last = heap.pop()!;
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
    if (distances.get(node) !== distance) continue;
    if (node === root) return true;
    for (const id of adjacency.get(node) ?? []) {
      const edge = index.physical[id]!, next = edge.from === node ? edge.to : edge.from;
      if (next < root || (next !== root && visited.has(next)) || (next === root && id <= firstEdge)) continue;
      if (edge.distance > budget - distance) continue;
      const following = distance + edge.distance;
      if (labels[next]! > budget - following || following >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, following); push(following, next);
    }
  }
  return false;
}

type Circuit = { physical: number[]; nodes: number[]; orientations: number[][]; distance: number; gain: number; road: number };
/** Integer upper sums describe an entire circuit, independent of rotation and
 * route-order rounding. They are bounds, never replacement feasibility facts. */
function circuitUpper(graph: TrailGraph, circuit: Circuit, trailsOnly = false): number {
  return Math.max(...circuit.orientations.map(parts => parts.reduce((sum, id) =>
    sum + (trailsOnly && graph.edges[id]!.connector ? 0 : Math.ceil(graph.edges[id]!.distance)), 0)));
}
function repetitionDenominator(index: Index, query: SearchQuery, roads = false): number {
  const value = 1 - (index.stemRatio + 1) * query.repetition - (roads ? (query.roads ?? DEFAULT_ROAD_LIMITS).fraction : 0);
  return value > Number.EPSILON * 16 && Number.isFinite(index.rounding) ? value - Number.EPSILON * 16 : 0;
}
/** The ordered nonroad itinerary fixes its once-used main-circuit trails;
 * stem trails appear twice. For every road substitution with that itinerary,
 * D = T + Rc + A + B, Rc <= fD, A <= kB, B <= rD. Consequently
 * D <= T/(1-(k+1)r-f). A too-small trail circuit cannot qualify OR suppress a
 * qualifying padded road substitute, so minimum-zero normalization remains exact. */
function possibleFamily(graph: TrailGraph, index: Index, query: SearchQuery, circuit: Circuit, minimum: number): boolean {
  if (!minimum) return true;
  const denominator = repetitionDenominator(index, query, true);
  return !denominator || (circuitUpper(graph, circuit, true) + index.rounding) / denominator + index.rounding >= minimum;
}
/** A simple circuit is rooted at its least node. First/last physical edge order
 * removes reversal; direction legality is evaluated separately, never assumed. */
function* circuits(graph: TrailGraph, index: Index, query: SearchQuery, cyclicBlocks: number[][], completedRoot: () => void): Generator<Circuit | undefined> {
  const budget = [query.distance[1], query.gain[1], (query.roads ?? DEFAULT_ROAD_LIMITS).distance]
    .map(value => Number.isSafeInteger(Math.floor(value)) ? Math.floor(value) : Infinity);
  const make = (path: number[], nodes: number[], sums: number[]): Circuit | undefined => {
    const orientations: number[][] = [];
    for (const backwards of [false, true]) {
      const parts = backwards ? path.toReversed() : path;
      const points = backwards ? [nodes[0]!, ...nodes.slice(1).toReversed()] : nodes;
      const edges: number[] = [];
      for (let part = 0; part < parts.length; part++) {
        const physical = index.physical[parts[part]!]!;
        const from = points[part]!;
        const to = points[(part + 1) % points.length]!;
        const id = physical.directions.find(id => {
          const edge = graph.edges[id]!;
          return edge.from === from && edge.to === to && (parts.length > 1 || edge.reverse === backwards);
        });
        if (id === undefined) break;
        edges.push(id);
      }
      if (edges.length === parts.length) orientations.push(edges);
    }
    return orientations.length ? { physical: [...path], nodes: [...nodes], orientations,
      distance: sums[0]!, gain: sums[1]!, road: sums[2]! } : undefined;
  };
  const scratch = [0, 1, 2].map(() => new Float64Array(index.incident.length));
  const returnParents = new Int32Array(index.incident.length);
  const gainScratch = [new Float64Array(index.incident.length), new Float64Array(index.incident.length)];
  const trailDenominator = repetitionDenominator(index, query, true);
  const minimumTrail = trailDenominator ? Math.max(0, (query.distance[0] - index.rounding) * trailDenominator - index.rounding) : 0;
  for (const block of cyclicBlocks) {
    const circuitBounds = createCircuitBounds(index.physical, block);
    const adjacency = new Map<number, number[]>();
    for (const id of block) {
      const edge = index.physical[id]!;
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), id]);
      if (edge.to !== edge.from) adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), id]);
    }
    for (const choices of adjacency.values()) choices.sort((a, b) => a - b);
    for (const root of circuitBounds.roots) {
      if (minimumTrail && circuitBounds.upper(root) < minimumTrail) { completedRoot(); yield undefined; continue; }
      let lowerReturn: (Float64Array | undefined)[] = [];
      let directedGain: (Float64Array | undefined)[] = [];
      yield undefined;
      const path: number[] = [];
      const nodes = [root];
      const visited = new Set(nodes);
      const frames: { node: number; next: number; sums: number[]; directions: (number[] | undefined)[] }[] = [{ node: root, next: 0, sums: [0, 0, 0], directions: [[0, 0, 0], [0, 0, 0]] }];
      while (frames.length) {
        const frame = frames[frames.length - 1]!;
        const choices = adjacency.get(frame.node)!;
        if (frame.next === choices.length) {
          frames.pop();
          if (path.length) { path.pop(); visited.delete(nodes.pop()!); }
          continue;
        }
        const id = choices[frame.next++]!;
        const edge = index.physical[id]!;
        const next = edge.from === frame.node ? edge.to : edge.from;
        const sums = [frame.sums[0]! + edge.distance, frame.sums[1]! + edge.gain, frame.sums[2]! + edge.road];
        let found: Circuit | undefined;
        if (id !== path.at(-1) && (next === root || !visited.has(next)) && sums.every((sum, metric) => sum <= budget[metric]!)) {
          if (!path.length && next !== root) {
            // A canonical closure must use a different, greater root edge.
            // Excluding the initial edge prevents the bound from promising an
            // illegal immediate retrace through the already used corridor.
            lowerReturn = ([0, 1, 2] as const).map(metric => lowerBounds(index, [root], budget[metric]!, metric,
              node => (adjacency.get(node) ?? []).filter(part => {
                const edge = index.physical[part]!;
                return (edge.from === node ? edge.to : edge.from) >= root
                  && ((edge.from !== root && edge.to !== root) || part > id);
              }), false, scratch[metric], metric === 0 ? returnParents : undefined));
            directedGain = [0, 1].map(direction => lowerBounds(index, [root], budget[1]!, 1,
              node => (adjacency.get(node) ?? []).filter(part => {
                const edge = index.physical[part]!;
                return (edge.from === node ? edge.to : edge.from) >= root
                  && ((edge.from !== root && edge.to !== root) || part > id);
              }), false, gainScratch[direction], undefined, (part, node) => {
                const edge = index.physical[part]!, other = edge.from === node ? edge.to : edge.from;
                const id = edge.directions.find(id => graph.edges[id]!.from === (direction ? node : other));
                return id === undefined ? undefined : Math.floor(graph.edges[id]!.gain);
              }));
          }
          const directions = frame.directions.map((previous, direction) => {
            if (!previous) return;
            const arc = edge.directions.find(part => {
              const directed = graph.edges[part]!;
              return directed.from === (direction ? next : frame.node) && directed.to === (direction ? frame.node : next)
                && (next !== frame.node || directed.reverse === Boolean(direction));
            });
            if (arc === undefined) return;
            const directed = graph.edges[arc]!;
            const total = [previous[0]! + Math.floor(directed.distance), previous[1]! + Math.floor(directed.gain),
              previous[2]! + (directed.connector ? Math.floor(directed.distance) : 0)];
            if (total.some((sum, metric) => sum > budget[metric]!) || (directedGain[direction] && directedGain[direction]![next]! > budget[1]! - total[1]!)) return;
            return total;
          });
          if (directions.every(value => !value)) { yield undefined; continue; }
          if (sums.some((sum, metric) => lowerReturn[metric] && lowerReturn[metric]![next]! > budget[metric]! - sum)) { yield undefined; continue; }
          if (next !== root && lowerReturn[0]) {
            let parent = returnParents[next]!;
            while (parent >= 0 && parent !== root && !visited.has(parent)) parent = returnParents[parent]!;
            if (parent >= 0 && parent !== root && !residualReturn(index, adjacency, root, next, path[0] ?? id,
              visited, lowerReturn[0], budget[0]! - sums[0]!)) { yield undefined; continue; }
          }
          if (next === root && (!path.length || path[0]! < id)) found = make([...path, id], nodes, sums);
          else if (next > root && !visited.has(next)) {
            path.push(id); nodes.push(next); visited.add(next);
            frames.push({ node: next, next: 0, sums, directions });
          }
        }
        yield found;
      }
      completedRoot();
    }
  }
}

function candidate(graph: TrailGraph, query: SearchQuery, start: number, edges: number[], back: number[]): RouteCandidate | undefined {
  let distance = 0, gain = 0, roadDistance = 0, repeatedDistance = 0;
  for (const id of edges) {
    const edge = graph.edges[id]!;
    distance += edge.distance; gain += edge.gain;
    if (edge.connector) roadDistance += edge.distance;
  }
  for (const id of back) repeatedDistance += graph.edges[id]!.distance;
  const repetition = repeatedDistance / distance;
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  if (distance < query.distance[0] || distance > query.distance[1] || gain < query.gain[0] || gain > query.gain[1]
    || roadDistance > roads.distance || roadDistance / distance > roads.fraction || repetition > query.repetition) return;
  return { id: `route-${start}-${edges.join('-')}`, start, edges, distance, gain, roadDistance, repetition,
    kind: back.length ? 'lollipop' : 'loop', uncertain: graph.starts[start]!.access === 'unknown'
      || edges.some(id => graph.edges[id]!.access === 'unknown') };
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
    const key = edges.join(',');
    const known = index.roadCertificates.get(key);
    if (known !== undefined) return known;
    let labels = index.roadShortest.get(to);
    if (!labels) {
      const budget = Math.min(query.distance[1], (query.roads ?? DEFAULT_ROAD_LIMITS).distance) + index.rounding;
      labels = sparseBounds([to], budget, node => {
        const choices: [number, number][] = [];
        for (const physicalId of index.incident[node]!) for (const id of index.physical[physicalId]!.directions) {
          const edge = graph.edges[id]!;
          if (edge.connector && edge.to === node) choices.push([edge.from, edge.distance]);
        }
        return choices;
      });
      if (index.roadShortest.size >= 128) index.roadShortest.delete(index.roadShortest.keys().next().value!);
      index.roadShortest.set(to, labels);
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
        if (alternativeId === id || !alternative.connector || alternative.from !== edge.from) continue;
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
        if (alternative && alternative.roadDistance < route.roadDistance && (!alternative.uncertain || route.uncertain)) return alternative;
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

type ApproachTarget = { node: number; starts: number[]; distance: Float64Array; road: Float64Array; repeated: Float64Array; parents: Int32Array };
type ApproachTargets = { positions: Map<number, number>; nodes: number[]; targets: ApproachTarget[] };
/** Every valid stem is inside this conservative reversible ball around the
 * circuit. Labels to its local eligible starts may ignore visited vertices;
 * that only makes the optimistic bounds smaller. */
function approachTargets(graph: TrailGraph, index: Index, query: SearchQuery, circuit: Circuit, coreUpper: number, denominator: number): ApproachTargets | undefined {
  const forbidden = new Set(circuit.nodes), roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  const maximum = denominator ? Math.min(query.distance[1], (coreUpper + index.rounding) / denominator + index.rounding) : query.distance[1];
  const budget = Math.min(query.distance[1] - circuit.distance,
    Number.isFinite(index.stemRatio) ? (index.stemRatio + 1) * query.repetition * maximum + index.rounding : Infinity);
  if (!Number.isSafeInteger(Math.ceil(budget))) return;
  const allowed = (physicalId: number) => {
    const edge = index.physical[physicalId]!;
    return edge.directions.length === 2
      && (!Number.isSafeInteger(Math.floor(query.gain[1])) || index.approachCost[physicalId]![1]! <= query.gain[1] - circuit.gain)
      && (!Number.isSafeInteger(Math.floor(roads.distance)) || index.approachCost[physicalId]![2]! <= roads.distance - circuit.road);
  };
  const ball = sparseBounds(circuit.nodes, Math.ceil(budget), node => {
    const choices: [number, number][] = [];
    for (const id of index.incident[node]!) {
      const edge = index.physical[id]!, next = edge.from === node ? edge.to : edge.from;
      if (!forbidden.has(next) && allowed(id)) choices.push([next, index.approachCost[id]![0]!]);
    }
    return choices;
  });
  const nodes = [...ball.keys()].filter(node => !forbidden.has(node));
  const positions = new Map(nodes.map((node, position) => [node, position]));
  const targets = nodes.filter(node => index.starts[node]!.length);
  // This chooses an optimization, never a search allowance. If the local
  // label matrix would be expensive, the exact exhaustive fallback is used.
  if (targets.length * nodes.length > 1_000_000) return;
  const adjacency = nodes.map(node => {
    const edges: { next: number; distance: number; road: number; repeated: number }[] = [];
    for (const id of index.incident[node]!) {
      const edge = index.physical[id]!, other = edge.from === node ? edge.to : edge.from, next = positions.get(other);
      if (next === undefined || !allowed(id)) continue;
      const reverse = edge.directions.find(id => graph.edges[id]!.to === node)!;
      edges.push({ next, distance: index.approachCost[id]![0]!, road: index.approachCost[id]![2]!, repeated: Math.floor(graph.edges[reverse]!.distance) });
    }
    return edges;
  });
  return { positions, nodes, targets: targets.map(node => {
    const position = positions.get(node)!;
    const parents = new Int32Array(nodes.length).fill(-1);
    const labels = (metric: 'distance' | 'road' | 'repeated', limit: number) => {
      const values = new Float64Array(nodes.length).fill(Infinity);
      const tree = metric === 'distance' ? new Map<number, number>() : undefined;
      for (const [at, value] of sparseBounds([position], Math.floor(limit + index.rounding), at => adjacency[at]!.map(edge => [edge.next, edge[metric]]), tree)) values[at] = value;
      for (const [at, parent] of tree ?? []) parents[at] = parent;
      return values;
    };
    return { node, starts: index.starts[node]!, parents, distance: labels('distance', query.distance[1] - circuit.distance),
      road: labels('road', roads.distance - circuit.road), repeated: labels('repeated', query.repetition * maximum) };
  }) };
}

/** Every simple reversible approach is considered. Neither shortest paths nor
 * separate metric extrema can replace correlated, ordered walk measurements.
 * Completed-job callers retain only the preferred normalized witness for each
 * circuit/start/direction; raw diagnostic callers retain the complete stream. */
function* approaches(graph: TrailGraph, index: Index, query: SearchQuery, circuit: Circuit, prefer?: Options['prefer']): Generator<RouteCandidate | undefined> {
  const denominator = repetitionDenominator(index, query);
  const coreUpper = circuitUpper(graph, circuit);
  const distanceCeiling = (outward: number, repeated: number) => denominator
    ? Math.min(query.distance[1], (coreUpper + outward - index.stemRatio * repeated + index.rounding) / denominator + index.rounding)
    : query.distance[1];
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  // The prefix's integer floors/ceilings conservatively bound its real sums.
  // With a positive denominator every additional stem can only consume the
  // repetition budget; it cannot rescue a failed prefix by padding the walk.
  const possible = (outward: number, repeated: number, road: number) => {
    const ceiling = distanceCeiling(outward, repeated);
    return repeated <= query.repetition * ceiling + index.rounding
      && road + circuit.road <= roads.fraction * ceiling + index.rounding
      && query.distance[0] <= ceiling + index.rounding;
  };
  if (!possible(0, 0, 0)) return;
  const forbidden = new Set(circuit.nodes);
  const cycleTrails = new Set(circuit.physical);
  const budgets = [query.distance[1], query.gain[1], (query.roads ?? DEFAULT_ROAD_LIMITS).distance]
    .map(value => Number.isSafeInteger(Math.floor(value)) ? Math.floor(value) : Infinity);
  const witnesses = new Map<string, RouteCandidate>();
  const substitutions = new Map<string, { edges: number[]; nodes: Set<number> }[]>();
  const targets = prefer ? approachTargets(graph, index, query, circuit, coreUpper, denominator) : undefined;
  for (const attachment of circuit.nodes) {
    if (index.startBounds?.some((labels, metric) => labels && labels[attachment]! > budgets[metric]! - [circuit.distance, circuit.gain, circuit.road][metric]!)) continue;
    const rings = circuit.orientations.map(edges => {
      const first = edges.findIndex(id => graph.edges[id]!.from === attachment);
      return [...edges.slice(first), ...edges.slice(0, first)];
    });
    const ringUnknown = rings.map(ring => ring.some(id => graph.edges[id]!.access === 'unknown'));
    const path: number[] = [];
    const visited = new Set([attachment]);
    const frames = [{ node: attachment, next: -1, sums: [0, 0, 0], repeated: 0, outward: 0, uncertain: false }];
    const canImprove = (frame: typeof frames[number]) => {
      if (!targets || frame.node === attachment) return true;
      const position = targets.positions.get(frame.node);
      if (position === undefined) return false;
      let outwardRoad = 0;
      for (let at = path.length - 1; at >= 0; at--) { const edge = graph.edges[index.reverse[path[at]!]!]!; if (edge.connector) outwardRoad += edge.distance; }
      // Adding roads at either end of this exact ordered prefix walk is
      // monotone; retaining that order preserves equality with an incumbent.
      const prefixRoad = rings.map(() => outwardRoad);
      for (let direction = 0; direction < rings.length; direction++) {
        let road = prefixRoad[direction]!;
        for (const id of rings[direction]!) { const edge = graph.edges[id]!; if (edge.connector) road += edge.distance; }
        for (const id of path) { const edge = graph.edges[id]!; if (edge.connector) road += edge.distance; }
        prefixRoad[direction] = road;
      }
      const ceiling = distanceCeiling(frame.outward, frame.repeated);
      const promising = new Set<number>();
      for (const target of targets.targets) {
        if (visited.has(target.node)) continue;
        const remaining = target.distance[position]!, addedRoad = target.road[position]!, addedReturn = target.repeated[position]!;
        if (remaining + frame.sums[0]! + circuit.distance > query.distance[1] + index.rounding
          || addedRoad + frame.sums[2]! + circuit.road > roads.distance + index.rounding
          || addedReturn + frame.repeated > query.repetition * ceiling + index.rounding) continue;
        const repeated = Math.max(0, frame.repeated + addedReturn - index.rounding);
        const repetition = repeated && Number.isFinite(index.stemRatio)
          ? repeated / (coreUpper + (index.stemRatio + 1) * repeated + index.rounding) : 0;
        for (const start of target.starts) for (let direction = 0; direction < rings.length; direction++) {
          const previous = witnesses.get(`${start}:${direction}`);
          if (!previous) { promising.add(target.node); continue; }
          const uncertain = frame.uncertain || ringUnknown[direction] || graph.starts[start]!.access === 'unknown';
          if (Number(uncertain) < Number(previous.uncertain)) { promising.add(target.node); continue; }
          if (Number(uncertain) > Number(previous.uncertain)) continue;
          const lowerRoad = addedRoad ? prefixRoad[direction]! + addedRoad - index.rounding : prefixRoad[direction]!;
          if (lowerRoad < previous.roadDistance) { promising.add(target.node); continue; }
          if (lowerRoad > previous.roadDistance) continue;
          if (repetition <= previous.repetition) promising.add(target.node); // Ties may improve stable IDs.
        }
        if (promising.has(target.node)) {
          let parent = target.parents[position]!;
          while (parent >= 0 && !visited.has(targets.nodes[parent]!)) parent = target.parents[parent]!;
          if (parent < 0) return true; // A promised target path avoids the prefix.
        }
      }
      if (!promising.size) return false;
      // Only when all optimistic witnesses cross the prefix, check the actual
      // residual component. Unreachable starts cannot keep dead branches alive.
      const pending = [frame.node], reached = new Set(pending);
      while (pending.length) {
        const node = pending.pop()!;
        if (promising.has(node)) return true;
        for (const physicalId of index.incident[node]!) {
          const edge = index.physical[physicalId]!, next = edge.from === node ? edge.to : edge.from;
          if (edge.directions.length !== 2 || !targets.positions.has(next) || visited.has(next) || reached.has(next)) continue;
          reached.add(next); pending.push(next);
        }
      }
      return false;
    };
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      if (frame.next === -1) {
        frame.next = 0;
        if (index.starts[frame.node]!.length) {
          const outward = path.toReversed().map(id => index.reverse[id]!);
          for (const start of index.starts[frame.node]!) for (const [direction, ring] of rings.entries()) {
            const route = candidate(graph, query, start, [...outward, ...ring, ...path], path);
            if (!prefer) { yield route; continue; }
            if (!route || !route.edges.some(id => !graph.edges[id]!.connector)) continue;
            const key = `${start}:${direction}`, previous = witnesses.get(key);
            if (previous && prefer(route, previous) >= 0) continue;
            const substitutionKey = `${attachment}:${direction}`;
            let dominated: RouteCandidate | undefined;
            const criteria = { ...query, distance: [0, query.distance[1]] as [number, number], gain: [0, query.gain[1]] as [number, number] };
            for (const replacement of substitutions.get(substitutionKey) ?? []) {
              if (path.some(id => replacement.nodes.has(graph.edges[id]!.to))) continue;
              const alternative = candidate(graph, criteria, start, [...outward, ...replacement.edges, ...path], path);
              if (alternative && alternative.roadDistance < route.roadDistance && (!alternative.uncertain || route.uncertain)) { dominated = alternative; break; }
            }
            if (!dominated) {
              dominated = yield* roadDominated(graph, index, query, route);
              if (dominated && outward.every((id, at) => dominated!.edges[at] === id)
                && path.every((id, at) => dominated!.edges[dominated!.edges.length - path.length + at] === id)) {
                const edges = dominated.edges.slice(outward.length, dominated.edges.length - path.length);
                const nodes = new Set(edges.map(id => graph.edges[id]!.to)); nodes.delete(attachment);
                let replacements = substitutions.get(substitutionKey);
                if (!replacements) { replacements = []; substitutions.set(substitutionKey, replacements); }
                // A bounded proof-witness cache changes only repeated work; a
                // miss always performs the complete exact substitution search.
                if (replacements.length < 8) replacements.push({ edges, nodes });
              }
            }
            if (!dominated) witnesses.set(key, route);
          }
        }
        if (prefer && !canImprove(frame)) frame.next = index.incident[frame.node]!.length;
      }
      const choices = index.incident[frame.node]!;
      if (frame.next === choices.length) {
        frames.pop();
        if (path.length) { path.pop(); visited.delete(frame.node); }
        continue;
      }
      const physicalId = choices[frame.next++]!;
      const physical = index.physical[physicalId]!;
      const next = physical.from === frame.node ? physical.to : physical.from;
      if (!cycleTrails.has(physicalId) && !forbidden.has(next) && !visited.has(next)) {
        const id = physical.directions.find(id => graph.edges[id]!.from === frame.node && index.reverse[id]! >= 0);
        if (id !== undefined) {
          const edge = graph.edges[id]!, reverse = graph.edges[index.reverse[id]!]!;
          const sums = [frame.sums[0]! + Math.floor(edge.distance) + Math.floor(reverse.distance),
            frame.sums[1]! + Math.floor(edge.gain) + Math.floor(reverse.gain),
            frame.sums[2]! + (edge.connector ? Math.floor(edge.distance) + Math.floor(reverse.distance) : 0)];
          const repeated = frame.repeated + Math.floor(edge.distance);
          const outward = frame.outward + Math.ceil(reverse.distance);
          if (possible(outward, repeated, sums[2]!) && repeated / query.distance[1] <= query.repetition && sums.every((sum, metric) =>
            sum + [circuit.distance, circuit.gain, circuit.road][metric]! <= budgets[metric]!
            && (!index.startBounds?.[metric] || index.startBounds[metric]![next]! <= budgets[metric]! - sum - [circuit.distance, circuit.gain, circuit.road][metric]!))) {
            path.push(id); visited.add(next); frames.push({ node: next, next: -1, sums, repeated, outward, uncertain: frame.uncertain || edge.access === 'unknown' || reverse.access === 'unknown' });
          }
        }
      }
      yield undefined;
    }
  }
  for (const route of witnesses.values()) yield route;
}

/** Exact private candidate stream. Production jobs use solveSection to apply
 * road normalization and distinct-family selection before publishing anything. */
export async function* search(graph: TrailGraph, query: SearchQuery, options: Options = {}): AsyncGenerator<SearchEvent> {
  validateQuery(query);
  query = { ...query, sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], roads: { ...(query.roads ?? DEFAULT_ROAD_LIMITS) } };
  const maximum = allowance(options.maxExpansions), maxResults = allowance(options.maxResults);
  const slice = options.sliceExpansions ?? 8192;
  if (!Number.isSafeInteger(slice) || slice < 1) throw new Error('Search slices must be positive integers');
  const started = Date.now();
  const progress: SearchProgress = { totalStarts: graph.starts.filter(start => query.includeUnknown || start.access === 'public').length,
    attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0 };
  const snapshot = () => ({ ...progress, elapsedMs: Date.now() - started });
  const stopped = (): SearchEvent => ({ type: 'done', status: 'stopped', reason: 'Search stopped', progress: snapshot() });
  yield { type: 'progress', progress: snapshot() };
  // Always yield once so cancellation timers can run even on a tiny section.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (options.signal?.aborted) { yield stopped(); return; }
  const index = indexGraph(graph, query);
  progress.totalStarts = progress.attemptedStarts = index.eligible.length;
  index.startBounds = ([0, 1, 2] as const).map(metric => lowerBounds(index, index.eligible.map(start => graph.starts[start]!.node),
    [query.distance[1], query.gain[1], query.roads!.distance][metric]!, metric, node => index.incident[node]!, true));
  yield { type: 'progress', progress: snapshot() };
  const cyclicBlocks = index.eligible.length ? blocks(index) : [];
  progress.totalSearchPoints = cyclicBlocks.reduce((total, block) => total + new Set(block.flatMap(id => {
    const edge = index.physical[id]!;
    return [edge.from, edge.to];
  })).size, 0);
  progress.completedSearchPoints = 0;
  yield { type: 'progress', progress: snapshot() };
  let results = 0, yieldedAt = performance.now();
  const limited = (): SearchEvent => ({ type: 'done', status: 'limited', progress: snapshot(),
    reason: results >= maxResults ? 'Result allowance reached; exploration is unfinished' : 'Expansion allowance reached; exploration is unfinished' });
  const visit = function* () {
    if (!index.eligible.length) return;
    for (const circuit of circuits(graph, index, query, cyclicBlocks, () => { progress.completedSearchPoints!++; })) {
      yield undefined;
      if (circuit && possibleFamily(graph, index, query, circuit, query.distance[0])) yield* approaches(graph, index, query, circuit, options.prefer);
    }
  };
  for (const route of visit()) {
    if (options.signal?.aborted) { yield stopped(); return; }
    if (progress.expansions >= maximum || results >= maxResults) { yield limited(); return; }
    progress.expansions++;
    if (route) { results++; yield { type: 'route', route }; }
    if (progress.expansions % slice === 0 || performance.now() - yieldedAt >= 8) {
      yield { type: 'progress', progress: snapshot() };
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      yieldedAt = performance.now();
    }
  }
  progress.completedStarts = progress.totalStarts;
  yield { type: 'done', status: 'complete', progress: snapshot() };
}
