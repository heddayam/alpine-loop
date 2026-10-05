import type { RouteCandidate, SearchEvent, SearchProgress, SearchQuery, TrailGraph } from '../model.js';
import { DEFAULT_ROAD_LIMITS } from '../model.js';

type Options = { signal?: AbortSignal; maxExpansions?: number; maxResults?: number; sliceExpansions?: number };
type Physical = { trail: number; from: number; to: number; directions: number[]; distance: number; gain: number; road: number };
type Index = { physical: Physical[]; incident: number[][]; reverse: Int32Array; starts: number[][]; eligible: number[]; approachCost: number[][]; startBounds?: (Float64Array | undefined)[] };

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
      road: first.connector ? Math.min(...directions.map(id => Math.floor(graph.edges[id]!.distance))) : 0 };
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
  return { physical, incident, reverse, starts, eligible, approachCost };
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
  for (const block of cyclicBlocks) {
    const adjacency = new Map<number, number[]>();
    for (const id of block) {
      const edge = index.physical[id]!;
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), id]);
      if (edge.to !== edge.from) adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), id]);
    }
    for (const choices of adjacency.values()) choices.sort((a, b) => a - b);
    for (const root of [...adjacency.keys()].sort((a, b) => a - b)) {
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

/** Every simple reversible approach is considered. Neither shortest paths nor
 * separate metric extrema can replace correlated, ordered walk measurements. */
function* approaches(graph: TrailGraph, index: Index, query: SearchQuery, circuit: Circuit): Generator<RouteCandidate | undefined> {
  const forbidden = new Set(circuit.nodes);
  const cycleTrails = new Set(circuit.physical);
  const budgets = [query.distance[1], query.gain[1], (query.roads ?? DEFAULT_ROAD_LIMITS).distance]
    .map(value => Number.isSafeInteger(Math.floor(value)) ? Math.floor(value) : Infinity);
  for (const attachment of circuit.nodes) {
    if (index.startBounds?.some((labels, metric) => labels && labels[attachment]! > budgets[metric]! - [circuit.distance, circuit.gain, circuit.road][metric]!)) continue;
    const rings = circuit.orientations.map(edges => {
      const first = edges.findIndex(id => graph.edges[id]!.from === attachment);
      return [...edges.slice(first), ...edges.slice(0, first)];
    });
    const path: number[] = [];
    const visited = new Set([attachment]);
    const frames = [{ node: attachment, next: -1, sums: [0, 0, 0], repeated: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      if (frame.next === -1) {
        frame.next = 0;
        if (index.starts[frame.node]!.length) {
          const outward = path.toReversed().map(id => index.reverse[id]!);
          for (const start of index.starts[frame.node]!) for (const ring of rings) {
            yield candidate(graph, query, start, [...outward, ...ring, ...path], path);
          }
        }
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
          if (repeated / query.distance[1] <= query.repetition && sums.every((sum, metric) =>
            sum + [circuit.distance, circuit.gain, circuit.road][metric]! <= budgets[metric]!
            && (!index.startBounds?.[metric] || index.startBounds[metric]![next]! <= budgets[metric]! - sum - [circuit.distance, circuit.gain, circuit.road][metric]!))) {
            path.push(id); visited.add(next); frames.push({ node: next, next: -1, sums, repeated });
          }
        }
      }
      yield undefined;
    }
  }
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
      if (circuit) yield* approaches(graph, index, query, circuit);
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
