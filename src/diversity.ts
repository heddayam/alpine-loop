import { createHash } from 'node:crypto';
import { search, validateQuery } from './engine/search.js';
import { canonical, compareNumbers, quality, walkKey } from './engine/quality.js';
import type { RouteCandidate, SearchProgress, SearchQuery, TrailGraph } from './model.js';

export type SolvedRoute = { route: RouteCandidate; groupId: string; variantId: string; direction: 0 | 1; reverseId?: string; oppositeId?: string; preferred: boolean; preferredVariant: boolean; preferredStart: boolean };
export type CandidatePool = {
  add(core: string, route: RouteCandidate): void;
  routes(core: string): Iterable<RouteCandidate>;
  delete(core: string): void;
};
type Core = { edges: number[]; key: number[] };
type Witnesses = [RouteCandidate | undefined, RouteCandidate | undefined];
const MIN_LOOP_SIMILARITY = 0.6;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
function cycleRange(graph: TrailGraph, route: RouteCandidate): [number, number] {
  let first = 0, last = route.edges.length - 1;
  while (first < last && graph.edges[route.edges[first]!]!.trail === graph.edges[route.edges[last]!]!.trail) { first++; last--; }
  return [first, last];
}
function coreOf(graph: TrailGraph, route: RouteCandidate): Core {
  const [first, last] = cycleRange(graph, route);
  const edges = route.edges.slice(first, last + 1);
  return { edges, key: canonical(edges.map(id => graph.edges[id]!.trail)) };
}

/** Group main circuits for display, while retaining qualifying starts and
 * directions separately for every exact circuit. Grouping never removes a circuit. */
export async function solveSection(graph: TrailGraph, query: SearchQuery,
  onProgress?: (progress: SearchProgress) => void | Promise<void>, savedPool?: CandidatePool): Promise<SolvedRoute[]> {
  validateQuery(query);
  query = { ...query, sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], roads: query.roads && { ...query.roads } };
  const batches = new Map<string, Core>();
  const memory = new Map<string, RouteCandidate[]>();
  const pool: CandidatePool = savedPool ?? {
    add(core, route) {
      const routes = memory.get(core);
      if (routes) routes.push(route);
      else memory.set(core, [route]);
    },
    routes: core => memory.get(core) ?? [],
    delete: core => { memory.delete(core); },
  };
  let progress: SearchProgress | undefined;
  for await (const event of search(graph, query)) {
    if (event.type !== 'route') {
      progress = event.progress;
      await onProgress?.(progress);
      if (event.type === 'done' && event.status !== 'complete') throw new Error('Section exploration did not complete');
      continue;
    }
    const route = event.route;
    const core = coreOf(graph, route), key = JSON.stringify(core.key);
    if (!batches.has(key)) batches.set(key, core);
    // Search already selects one route per exact circuit, start, and direction.
    pool.add(key, route);
  }
  const physical = new Map<number, (typeof graph.edges)[number]>();
  for (const edge of graph.edges) if (!physical.has(edge.trail) || !edge.reverse) physical.set(edge.trail, edge);
  let work = 0, lastYield = performance.now();
  const shouldYield = () => ++work % 256 === 0 && performance.now() - lastYield >= 25;
  const yieldProgress = async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (progress) await onProgress?.(progress);
    lastYield = performance.now();
  };
  const circuits = [...batches].sort((a, b) => compareNumbers(a[1].key, b[1].key));
  const footprints = circuits.map(([, core]) => new Set(core.key));
  const lengths = footprints.map(trails => [...trails].sort((a, b) => a - b)
    .reduce((total, trail) => total + physical.get(trail)!.distance, 0));
  const incident = new Map<number, number[]>();
  for (const [index, trails] of footprints.entries()) for (const trail of trails) {
    const members = incident.get(trail) ?? []; members.push(index); incident.set(trail, members);
  }
  // Keep only qualifying links. Unrelated circuits need no pair storage.
  const links = circuits.map(() => new Map<number, number>());
  for (const [a, trails] of footprints.entries()) {
    const shared = new Map<number, number>();
    for (const trail of [...trails].sort((a, b) => a - b)) for (const b of incident.get(trail)!) if (b > a) {
      shared.set(b, (shared.get(b) ?? 0) + physical.get(trail)!.distance);
      if (shouldYield()) await yieldProgress();
    }
    for (const [b, length] of shared) {
      const score = length / Math.max(lengths[a]!, lengths[b]!);
      if (score < MIN_LOOP_SIMILARITY) continue;
      const common = new Set([...trails].filter(trail => footprints[b]!.has(trail)));
      if (compareNumbers(canonical(circuits[a]![1].key.filter(trail => common.has(trail))),
        canonical(circuits[b]![1].key.filter(trail => common.has(trail))))) continue;
      links[a]!.set(b, score); links[b]!.set(a, score);
    }
  }
  const groups = new Map(circuits.map((_, index) => [index, [index]]));
  while (true) {
    let best = MIN_LOOP_SIMILARITY, left = -1, right = -1;
    for (const a of groups.keys()) for (const [b, score] of links[a]!) if (b > a) {
      if (score > best || (score === best && (left < 0 || a < left || (a === left && b < right)))) {
        best = score; left = a; right = b;
      }
      if (shouldYield()) await yieldProgress();
    }
    if (left < 0) break;
    groups.get(left)!.push(...groups.get(right)!); groups.delete(right);
    // A group link is its least similar cross pair. Missing links prevent a
    // merge, so a chain of similar neighbors cannot join unrelated endpoints.
    links[left]!.delete(right);
    for (const [other, score] of links[left]!) {
      const cross = links[right]!.get(other);
      if (cross === undefined) { links[left]!.delete(other); links[other]!.delete(left); }
      else { const minimum = Math.min(score, cross); links[left]!.set(other, minimum); links[other]!.set(left, minimum); }
    }
    for (const other of links[right]!.keys()) links[other]!.delete(right);
    links[right]!.clear();
    if (shouldYield()) await yieldProgress();
  }
  const result: SolvedRoute[] = [], rank = { trailhead: 0, parking: 1, 'road-contact': 2 };
  const preference = (a: SolvedRoute, b: SolvedRoute) => rank[graph.starts[a.route.start]!.kind] - rank[graph.starts[b.route.start]!.kind]
    || quality(graph, a.route, b.route) || graph.starts[a.route.start]!.id.localeCompare(graph.starts[b.route.start]!.id);
  for (const [first, members] of groups) {
    const groupId = `family-${hash(circuits[first]![0])}`, choices: SolvedRoute[] = [];
    for (const member of members.sort((a, b) => a - b)) {
      const [key, core] = circuits[member]!, variantId = `circuit-${hash(key)}`;
      const anchor = core.key[0]!, seedOrder = core.edges.map(id => graph.edges[id]!.trail);
      const position = seedOrder.indexOf(anchor);
      const forward = [...seedOrder.slice(position), ...seedOrder.slice(0, position)];
      const reversed = seedOrder.length < 3 ? graph.edges[core.edges[position]!]!.reverse : compareNumbers(forward, core.key) !== 0;
      const seedEdge = graph.edges[core.edges[position]!]!;
      const orientation = reversed ? !seedEdge.reverse : seedEdge.reverse;
      const starts = new Map<number, Witnesses>();
      for (const route of pool.routes(key)) {
        let witnesses = starts.get(route.start);
        if (!witnesses) { witnesses = [undefined, undefined]; starts.set(route.start, witnesses); }
        const edge = graph.edges[route.edges.find(id => graph.edges[id]!.trail === anchor)!]!;
        const direction = edge.reverse === orientation ? 0 : 1;
        if (!witnesses[direction] || quality(graph, route, witnesses[direction]!) < 0) witnesses[direction] = route;
        if (shouldYield()) await yieldProgress();
      }
      pool.delete(key);
      const versions: SolvedRoute[] = [];
      for (const witnesses of starts.values()) {
        for (const [direction, route] of witnesses.entries()) if (route) versions.push({ route, groupId, variantId,
          direction: direction as 0 | 1, preferred: false, preferredVariant: false, preferredStart: false });
      }
      versions.sort(preference);
      versions[0]!.preferredVariant = true;
      const selectedStarts = new Set<number>();
      for (const choice of versions) if (!selectedStarts.has(choice.route.start)) {
        choice.preferredStart = true;
        selectedStarts.add(choice.route.start);
      }
      const walks = new Map(versions.map(choice => [walkKey(graph, choice.route), choice.route.id]));
      const directions = new Map(versions.map(choice => [`${choice.route.start}:${choice.direction}`, choice.route.id]));
      for (const choice of versions) {
        choice.reverseId = walks.get(walkKey(graph, choice.route, true));
        choice.oppositeId = directions.get(`${choice.route.start}:${1 - choice.direction}`);
      }
      choices.push(...versions);
    }
    choices.sort(preference);
    choices[0]!.preferred = true;
    result.push(...choices);
  }
  return result;
}
