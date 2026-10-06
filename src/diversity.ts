import { createHash } from 'node:crypto';
import { search, validateQuery } from './engine/search.js';
import { canonical, compareNumbers, quality, walkKey } from './engine/quality.js';
import type { RouteCandidate, SearchProgress, SearchQuery, TrailGraph } from './model.js';

export type SolvedRoute = { route: RouteCandidate; groupId: string; direction: 0 | 1; reverseId?: string; oppositeId?: string; preferred: boolean; preferredStart: boolean };
export type CandidatePool = {
  add(core: string, route: RouteCandidate): void;
  routes(core: string): Iterable<RouteCandidate>;
  delete(core: string): void;
};
type Core = { edges: number[]; trails: Set<number>; order: number[]; key: number[] };
type Witnesses = [RouteCandidate | undefined, RouteCandidate | undefined];
type Family = { id: string; position: number; common: Set<number>; combined: Set<number>; order: number[];
  seed: Core; cores: string[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
function cycleRange(graph: TrailGraph, route: RouteCandidate): [number, number] {
  let first = 0, last = route.edges.length - 1;
  while (first < last && graph.edges[route.edges[first]!]!.trail === graph.edges[route.edges[last]!]!.trail) { first++; last--; }
  return [first, last];
}
function coreOf(graph: TrailGraph, route: RouteCandidate): Core {
  const [first, last] = cycleRange(graph, route);
  const edges = route.edges.slice(first, last + 1);
  const trails = edges.filter(id => !graph.edges[id]!.connector).map(id => graph.edges[id]!.trail);
  // A road circuit reached by a trail stem is still a permitted lollipop. Use
  // its physical circuit, rather than combining every such hike as empty.
  const order = trails.length ? trails : edges.map(id => graph.edges[id]!.trail);
  return { edges, trails: new Set(order), order, key: canonical(edges.map(id => graph.edges[id]!.trail)) };
}

/** Group the privately completed discovery pool. Strict qualifying, road-normalized
 * candidates become final family/start/direction witnesses here. */
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
  const sum = (trails: Set<number>) => [...trails].sort((a, b) => a - b).reduce((total, trail) => total + physical.get(trail)!.distance, 0);
  const families: Family[] = [];
  const incidentFamilies = new Map<number, Set<Family>>();
  function merge(family: Family, core: Core): { common: Set<number>; combined: Set<number> } | undefined {
    const common = new Set([...family.common].filter(trail => core.trails.has(trail)));
    const combined = new Set([...family.combined, ...core.trails]);
    if (sum(common) / sum(combined) < 0.85) return;
    if (compareNumbers(canonical(family.order.filter(trail => common.has(trail))), canonical(core.order.filter(trail => common.has(trail))))) return;
    const differences = new Set([...combined].filter(trail => !common.has(trail)));
    const incident = new Map<number, number[]>();
    for (const trail of differences) {
      const edge = physical.get(trail)!;
      for (const node of [edge.from, edge.to]) incident.set(node, [...(incident.get(node) ?? []), trail]);
    }
    for (const seed of differences) {
      const pending = [seed]; differences.delete(seed);
      let length = 0;
      while (pending.length) {
        const edge = physical.get(pending.pop()!)!;
        length += edge.distance;
        if (length > 1000) return;
        for (const node of [edge.from, edge.to]) for (const next of incident.get(node) ?? []) if (differences.delete(next)) pending.push(next);
      }
    }
    return { common, combined };
  }
  let work = 0;
  for (const [key, core] of [...batches].sort((a, b) => compareNumbers(a[1].key, b[1].key))) {
    const possible = new Set<Family>();
    for (const trail of core.trails) for (const family of incidentFamilies.get(trail) ?? []) possible.add(family);
    let family: Family | undefined;
    for (const choice of [...possible].sort((a, b) => a.position - b.position)) {
      const merged = merge(choice, core);
      if (!merged) continue;
      family = choice;
      for (const trail of family.common) if (!merged.common.has(trail)) {
        incidentFamilies.get(trail)!.delete(family);
      }
      Object.assign(family, merged);
      break;
    }
    if (!family) {
      family = { id: `family-${hash(JSON.stringify(core.key))}`, position: families.length, common: new Set(core.trails),
        combined: new Set(core.trails), order: core.order, seed: core, cores: [] };
      families.push(family);
      for (const trail of family.common) {
        let choices = incidentFamilies.get(trail);
        if (!choices) { choices = new Set(); incidentFamilies.set(trail, choices); }
        choices.add(family);
      }
    }
    family.cores.push(key);
    if (++work % 256 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); if (progress) await onProgress?.(progress); }
  }
  const result: SolvedRoute[] = [], rank = { trailhead: 0, parking: 1, 'road-contact': 2 };
  for (const family of families) {
    // Membership is final. One shared trail now identifies both directions.
    const anchor = Math.min(...family.common), seedOrder = family.seed.edges.map(id => graph.edges[id]!.trail);
    const position = seedOrder.indexOf(family.seed.key[0]!);
    const forward = [...seedOrder.slice(position), ...seedOrder.slice(0, position)];
    const reversed = seedOrder.length < 3 ? graph.edges[family.seed.edges[position]!]!.reverse : compareNumbers(forward, family.seed.key) !== 0;
    const seedEdge = graph.edges[family.seed.edges.find(id => graph.edges[id]!.trail === anchor)!]!;
    const orientation = reversed ? !seedEdge.reverse : seedEdge.reverse;
    const starts = new Map<number, Witnesses>();
    for (const key of family.cores) {
      for (const route of pool.routes(key)) {
        let witnesses = starts.get(route.start);
        if (!witnesses) { witnesses = [undefined, undefined]; starts.set(route.start, witnesses); }
        const edge = graph.edges[route.edges.find(id => graph.edges[id]!.trail === anchor)!]!;
        const direction = edge.reverse === orientation ? 0 : 1;
        if (!witnesses[direction] || quality(graph, route, witnesses[direction]!) < 0) witnesses[direction] = route;
        if (++work % 256 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); if (progress) await onProgress?.(progress); }
      }
      pool.delete(key);
    }
    const choices: SolvedRoute[] = [];
    for (const witnesses of starts.values()) {
      for (const [direction, route] of witnesses.entries()) if (route) choices.push({ route, groupId: family.id,
        direction: direction as 0 | 1, preferred: false, preferredStart: false });
    }
    choices.sort((a, b) => rank[graph.starts[a.route.start]!.kind] - rank[graph.starts[b.route.start]!.kind]
      || quality(graph, a.route, b.route) || graph.starts[a.route.start]!.id.localeCompare(graph.starts[b.route.start]!.id));
    choices[0]!.preferred = true;
    const selectedStarts = new Set<number>();
    for (const choice of choices) if (!selectedStarts.has(choice.route.start)) {
      choice.preferredStart = true;
      selectedStarts.add(choice.route.start);
    }
    const walks = new Map(choices.map(choice => [walkKey(graph, choice.route), choice.route.id]));
    const directions = new Map(choices.map(choice => [`${choice.route.start}:${choice.direction}`, choice.route.id]));
    for (const choice of choices) {
      choice.reverseId = walks.get(walkKey(graph, choice.route, true));
      choice.oppositeId = directions.get(`${choice.route.start}:${1 - choice.direction}`);
    }
    result.push(...choices);
  }
  return result;
}
