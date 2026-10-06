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
export const MIN_LOOP_SIMILARITY = 0.6;
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
  type Choice = Omit<SolvedRoute, 'groupId'>;
  const rank = { trailhead: 0, parking: 1, 'road-contact': 2 };
  const preference = (a: Choice, b: Choice) => rank[graph.starts[a.route.start]!.kind] - rank[graph.starts[b.route.start]!.kind]
    || quality(graph, a.route, b.route) || graph.starts[a.route.start]!.id.localeCompare(graph.starts[b.route.start]!.id);
  const variants: { core: Core; choices: Choice[]; trails: Set<number>; length: number; key: string }[] = [];
  for (const [key, core] of batches) {
    const variantId = `circuit-${hash(key)}`;
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
    const versions: Choice[] = [];
    for (const witnesses of starts.values()) {
      for (const [direction, route] of witnesses.entries()) if (route) versions.push({ route, variantId,
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
    const trails = new Set(core.key);
    const length = [...trails].sort((a, b) => a - b).reduce((total, trail) => total + physical.get(trail)!.distance, 0);
    variants.push({ core, choices: versions, trails, length, key });
  }
  variants.sort((a, b) => preference(a.choices[0]!, b.choices[0]!) || compareNumbers(a.core.key, b.core.key));
  const representatives: (typeof variants)[number][] = [], result: SolvedRoute[] = [];
  for (const variant of variants) {
    let representative: (typeof variants)[number] | undefined, best = MIN_LOOP_SIMILARITY;
    for (const shown of representatives) {
      const common = variant.core.key.filter(trail => shown.trails.has(trail));
      const length = [...common].sort((a, b) => a - b).reduce((total, trail) => total + physical.get(trail)!.distance, 0);
      const score = length / Math.max(variant.length, shown.length);
      if (score >= best && compareNumbers(canonical(common), canonical(shown.core.key.filter(trail => variant.trails.has(trail)))) === 0
        && (!representative || score > best)) { representative = shown; best = score; }
      if (shouldYield()) await yieldProgress();
    }
    if (!representative) {
      representative = variant;
      representatives.push(variant);
      variant.choices[0]!.preferred = true;
    }
    // Keep the displayed route fixed: a hidden version must not keep similar
    // displayed hikes apart, or replace the route that defines membership.
    const groupId = `family-${hash(representative.key)}`;
    result.push(...variant.choices.map(choice => ({ ...choice, groupId })));
  }
  return result;
}
