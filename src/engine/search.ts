import type { RouteCandidate, SearchEvent, SearchProgress, SearchQuery, TrailGraph } from '../model.js';

type Options = {
  signal?: AbortSignal;
  maxExpansions?: number;
  maxResults?: number;
  sliceExpansions?: number;
};

function validateQuery(query: SearchQuery): void {
  for (const range of [query.distance, query.gain]) {
    if (range.length !== 2 || range.some(value => !Number.isFinite(value) || value < 0) || range[0] > range[1]) {
      throw new Error('Search distance and gain need ordered, finite, nonnegative ranges');
    }
  }
  const [west, south, east, north] = query.area;
  if (query.area.length !== 4 || query.area.some(value => !Number.isFinite(value)) || west > east || south > north) {
    throw new Error('Search area needs ordered, finite bounds');
  }
  if (!Number.isFinite(query.repetition) || query.repetition < 0 || query.repetition > 1) {
    throw new Error('Repeated trail must be a fraction between zero and one');
  }
}

function allowance(value: number | undefined): number {
  if (value === undefined || value === Infinity) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Search allowances must be nonnegative integers');
  return value;
}

/** Each cursor keeps its frontier between turns; a larger allowance never replays it. */
function* routesFromStart(
  graph: TrailGraph,
  query: SearchQuery,
  start: number,
  outgoing: readonly number[][],
  reverse: Int32Array,
): Generator<RouteCandidate | undefined> {
  const origin = graph.starts[start]!;
  const path: number[] = [];
  const positions = new Map([[origin.node, 0]]);
  const usedTrails = new Set<number>();
  const frames = [{ node: origin.node, next: 0, distance: 0, gain: 0 }];
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    const choices = outgoing[frame.node]!;
    if (frame.next === choices.length) {
      frames.pop();
      if (path.length) {
        positions.delete(frame.node);
        usedTrails.delete(graph.edges[path.pop()!]!.trail);
      }
      continue;
    }
    const index = choices[frame.next++]!;
    const edge = graph.edges[index]!;
    const distance = frame.distance + edge.distance;
    const gain = frame.gain + edge.gain;
    let route: RouteCandidate | undefined;
    // Nonnegative metrics make these necessary prefix conditions. Summation
    // follows original route order, including the return stem below.
    if (!usedTrails.has(edge.trail) && distance <= query.distance[1] && gain <= query.gain[1]) {
      const attachment = positions.get(edge.to);
      if (attachment === undefined) {
        path.push(index);
        usedTrails.add(edge.trail);
        positions.set(edge.to, path.length);
        frames.push({ node: edge.to, next: 0, distance, gain });
      } else {
        let returnCount = 0;
        let totalDistance = distance;
        let totalGain = gain;
        let repeatedDistance = 0;
        for (let part = attachment - 1; part >= 0; part--) {
          const back = reverse[path[part]!]!;
          if (back < 0) break;
          returnCount++;
          totalDistance += graph.edges[back]!.distance;
          totalGain += graph.edges[back]!.gain;
          repeatedDistance += graph.edges[back]!.distance;
        }
        const repetition = repeatedDistance / totalDistance;
        if (returnCount === attachment
          && totalDistance >= query.distance[0] && totalDistance <= query.distance[1]
          && totalGain >= query.gain[0] && totalGain <= query.gain[1]
          && repetition <= query.repetition) {
          const edges = [...path, index];
          for (let part = attachment - 1; part >= 0; part--) edges.push(reverse[path[part]!]!);
          route = {
            id: `route-${start}-${edges.join('-')}`,
            start, edges, distance: totalDistance, gain: totalGain, repetition,
            kind: attachment === 0 ? 'loop' : 'lollipop',
            uncertain: origin.access === 'unknown' || edges.some(id => graph.edges[id]!.access === 'unknown'),
          };
        }
      }
    }
    // Count every examined edge, including rejected choices. The scheduler
    // therefore also controls work in branches that produce no routes.
    yield route;
  }
}

/**
 * Exhaustive within the supplied graph if allowed to finish. Geographic bounds
 * select starts only. Directions and alternative qualifying stems remain visible;
 * no ranking, diversity heuristic or hidden result cap discards valid routes.
 */
export async function* search(graph: TrailGraph, query: SearchQuery, options: Options = {}): AsyncGenerator<SearchEvent> {
  validateQuery(query);
  query = { ...query, area: [...query.area], distance: [...query.distance], gain: [...query.gain] };
  const maxExpansions = allowance(options.maxExpansions);
  const maxResults = allowance(options.maxResults);
  const slice = options.sliceExpansions ?? 256;
  if (!Number.isSafeInteger(slice) || slice < 1) throw new Error('Search slices must be positive integers');
  const started = Date.now();
  const progress: SearchProgress = { totalStarts: 0, attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0 };
  const snapshot = (): SearchProgress => ({ ...progress, elapsedMs: Math.max(0, Date.now() - started) });
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const includeUnknown = query.includeUnknown !== false;
  const eligible: number[] = [];
  for (const [index, start] of graph.starts.entries()) {
    const position = graph.nodes[start.node];
    if (!position) throw new Error(`Missing node for start ${start.id}`);
    if (!['public', 'unknown'].includes(start.access)) throw new Error(`Invalid access for start ${start.id}`);
    if ((includeUnknown || start.access === 'public')
      && position[0] >= query.area[0] && position[0] <= query.area[2]
      && position[1] >= query.area[1] && position[1] <= query.area[3]) eligible.push(index);
  }
  progress.totalStarts = eligible.length;
  yield { type: 'progress', progress: snapshot() };
  const stopped = (): SearchEvent => ({ type: 'done', status: 'stopped', progress: snapshot(), reason: 'Search stopped' });
  if (options.signal?.aborted) { yield stopped(); return; }
  if (!eligible.length) { yield { type: 'done', status: 'complete', progress: snapshot() }; return; }

  const outgoing = Array.from({ length: graph.nodes.length }, () => [] as number[]);
  const directed = new Map<string, number>();
  const reverse = new Int32Array(graph.edges.length).fill(-1);
  for (const [index, edge] of graph.edges.entries()) {
    if (!Number.isInteger(edge.from) || !Number.isInteger(edge.to) || !graph.nodes[edge.from] || !graph.nodes[edge.to]
      || !Number.isSafeInteger(edge.trail) || edge.trail < 0
      || !Number.isFinite(edge.distance) || edge.distance <= 0 || !Number.isFinite(edge.gain) || edge.gain < 0
      || typeof edge.reverse !== 'boolean' || !['public', 'unknown'].includes(edge.access)) throw new Error(`Invalid trail edge ${index}`);
    const key = `${edge.trail}:${edge.reverse}`;
    if (directed.has(key)) throw new Error(`Duplicate trail direction ${key}`);
    directed.set(key, index);
    if (includeUnknown || edge.access === 'public') outgoing[edge.from]!.push(index);
    if (index % 8192 === 8191) {
      await pause();
      if (options.signal?.aborted) { yield stopped(); return; }
    }
  }
  for (const [index, edge] of graph.edges.entries()) {
    if (index % 8192 === 8191) {
      await pause();
      if (options.signal?.aborted) { yield stopped(); return; }
    }
    const back = directed.get(`${edge.trail}:${!edge.reverse}`);
    if (back === undefined) continue;
    const other = graph.edges[back]!;
    if (other.from !== edge.to || other.to !== edge.from) throw new Error(`Mismatched reverse for edge ${index}`);
    if (includeUnknown || other.access === 'public') reverse[index] = back;
  }

  const active = eligible.map(start => ({ cursor: routesFromStart(graph, query, start, outgoing, reverse), attempted: false }));
  let results = 0;
  let yieldedAt = performance.now();
  let firstPass = true;
  while (active.length) {
    for (let position = 0; position < active.length;) {
      if (options.signal?.aborted) { yield stopped(); return; }
      if (progress.expansions >= maxExpansions || results >= maxResults) {
        yield { type: 'done', status: 'limited', progress: snapshot(),
          reason: results >= maxResults ? 'Result allowance reached; exploration is unfinished' : 'Expansion allowance reached; exploration is unfinished' };
        return;
      }
      const task = active[position]!;
      // Give each start one step before taking deeper slices anywhere.
      const turns = task.attempted ? slice : 1;
      if (!task.attempted) { task.attempted = true; progress.attemptedStarts++; }
      let complete = false;
      for (let step = 0; step < turns && progress.expansions < maxExpansions && results < maxResults; step++) {
        if (options.signal?.aborted) { yield stopped(); return; }
        const next = task.cursor.next();
        if (next.done) { complete = true; progress.completedStarts++; break; }
        progress.expansions++;
        if (next.value) { results++; yield { type: 'route', route: next.value }; }
      }
      if (complete) active.splice(position, 1);
      else position++;
      // Turns distribute work between starts; only elapsed time needs a timer.
      // Sleeping after every small turn otherwise spends most wall time idle.
      if (performance.now() - yieldedAt >= 8) {
        yield { type: 'progress', progress: snapshot() };
        await pause();
        yieldedAt = performance.now();
      }
    }
    if (firstPass && active.length) {
      firstPass = false;
      yield { type: 'progress', progress: snapshot() };
      await pause();
      yieldedAt = performance.now();
    }
  }
  yield { type: 'done', status: 'complete', progress: snapshot() };
}
