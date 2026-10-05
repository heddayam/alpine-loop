import { createHash } from 'node:crypto';
import { search, validateQuery } from './engine/search.js';
import type { RouteCandidate, SearchProgress, SearchQuery, TrailGraph } from './model.js';

export type SolvedRoute = { route: RouteCandidate; groupId: string; direction: 0 | 1; reverseId?: string; preferred: boolean };
type Core = { edges: number[]; trails: Set<number>; order: number[]; key: number[] };
type Family = { id: string; common: Set<number>; combined: Set<number>; order: number[];
  orientation: Map<number, boolean>; candidates: { route: RouteCandidate; core: Core }[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const compareNumbers = (a: number[], b: number[]) => {
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};
function canonical(order: number[]): number[] {
  if (!order.length) return [];
  const smallest = Math.min(...order), at = order.indexOf(smallest);
  const forward = [...order.slice(at), ...order.slice(0, at)];
  const back = [forward[0]!, ...forward.slice(1).toReversed()];
  return compareNumbers(forward, back) <= 0 ? forward : back;
}
function coreOf(graph: TrailGraph, route: RouteCandidate): Core {
  let first = 0, last = route.edges.length - 1;
  while (first < last && graph.edges[route.edges[first]!]!.trail === graph.edges[route.edges[last]!]!.trail) { first++; last--; }
  const edges = route.edges.slice(first, last + 1);
  const trails = edges.filter(id => !graph.edges[id]!.connector).map(id => graph.edges[id]!.trail);
  // A road circuit reached by a trail stem is still a permitted lollipop. In
  // that unusual case use its physical circuit, rather than one empty identity.
  const order = trails.length ? trails : edges.map(id => graph.edges[id]!.trail);
  return { edges, trails: new Set(order), order, key: canonical(edges.map(id => graph.edges[id]!.trail)) };
}
function walkKey(graph: TrailGraph, route: RouteCandidate, reverse = false): string {
  const edges = reverse ? route.edges.toReversed() : route.edges;
  return JSON.stringify([graph.starts[route.start]!.id,
    edges.map(id => [graph.edges[id]!.trail, reverse ? !graph.edges[id]!.reverse : graph.edges[id]!.reverse])]);
}
function quality(graph: TrailGraph, a: RouteCandidate, b: RouteCandidate): number {
  for (const difference of [Number(a.uncertain) - Number(b.uncertain), a.roadDistance - b.roadDistance,
    a.repetition - b.repetition, a.distance - b.distance]) if (difference) return difference;
  const pair = (route: RouteCandidate) => {
    const forward = walkKey(graph, route), back = walkKey(graph, route, true);
    return forward < back ? forward : back;
  };
  return pair(a).localeCompare(pair(b)) || a.id.localeCompare(b.id);
}

/** Complete a section privately. Minimums are applied only after every legal
 * road substitution has had a chance to invalidate mileage/climb padding. */
export async function solveSection(graph: TrailGraph, query: SearchQuery,
  onProgress?: (progress: SearchProgress) => void | Promise<void>): Promise<SolvedRoute[]> {
  validateQuery(query);
  query = { ...query, sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], roads: query.roads && { ...query.roads } };
  const alternatives = new Map<string, { known?: { road: number; best: Map<string, RouteCandidate> }; unknown?: { road: number; best: Map<string, RouteCandidate> } }>();
  let progress: SearchProgress | undefined;
  const qualifies = (route: RouteCandidate) => route.distance >= query.distance[0] && route.gain >= query.gain[0];
  for await (const event of search(graph, { ...query, distance: [0, query.distance[1]], gain: [0, query.gain[1]] })) {
    if (event.type !== 'route') {
      progress = event.progress;
      await onProgress?.(progress);
      if (event.type === 'done' && event.status !== 'complete') throw new Error('Section exploration did not complete');
      continue;
    }
    const route = event.route;
    if (!route.edges.some(id => !graph.edges[id]!.connector)) continue;
    route.id = `route-${hash(walkKey(graph, route))}`;
    const key = JSON.stringify([graph.starts[route.start]!.id, route.edges.filter(id => !graph.edges[id]!.connector)
      .map(id => [graph.edges[id]!.trail, graph.edges[id]!.reverse])]);
    let choices = alternatives.get(key);
    if (!choices) { choices = {}; alternatives.set(key, choices); }
    const certainty = route.uncertain ? 'unknown' : 'known';
    const core = coreOf(graph, route);
    const hasCoreTrail = core.edges.some(id => !graph.edges[id]!.connector);
    const anchor = core.key[0]!;
    const keeper = hasCoreTrail ? '' : JSON.stringify([core.key, graph.edges[core.edges.find(id => graph.edges[id]!.trail === anchor)!]!.reverse]);
    const prior = choices[certainty];
    if (!prior || route.roadDistance < prior.road) choices[certainty] = { road: route.roadDistance,
      best: new Map(qualifies(route) ? [[keeper, route]] : []) };
    else if (route.roadDistance === prior.road && qualifies(route)) {
      const previous = prior.best.get(keeper);
      if (!previous || quality(graph, route, previous) < 0) prior.best.set(keeper, route);
    }
  }
  const candidates: { route: RouteCandidate; core: Core }[] = [];
  for (const { known, unknown } of alternatives.values()) {
    for (const route of known?.best.values() ?? []) candidates.push({ route, core: coreOf(graph, route) });
    if (unknown && (!known || known.road >= unknown.road)) {
      for (const route of unknown.best.values()) candidates.push({ route, core: coreOf(graph, route) });
    }
  }
  alternatives.clear();
  candidates.sort((a, b) => compareNumbers(a.core.key, b.core.key) || a.route.id.localeCompare(b.route.id));
  const physical = new Map<number, (typeof graph.edges)[number]>();
  for (const edge of graph.edges) if (!physical.has(edge.trail) || !edge.reverse) physical.set(edge.trail, edge);
  const sum = (trails: Set<number>) => [...trails].sort((a, b) => a - b).reduce((total, trail) => total + physical.get(trail)!.distance, 0);
  const families: Family[] = [];
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
  for (const candidate of candidates) {
    let family: Family | undefined;
    for (const choice of families) {
      const merged = merge(choice, candidate.core);
      if (merged) { family = choice; Object.assign(family, merged); break; }
    }
    if (!family) {
      const seedOrder = candidate.core.edges.map(id => graph.edges[id]!.trail);
      const canonicalOrder = canonical(seedOrder);
      const anchor = canonicalOrder[0]!;
      const position = seedOrder.indexOf(anchor);
      const forward = [...seedOrder.slice(position), ...seedOrder.slice(0, position)];
      const reversed = compareNumbers(forward, canonicalOrder) !== 0;
      const orientation = new Map(candidate.core.edges.map(id => [graph.edges[id]!.trail,
        reversed ? !graph.edges[id]!.reverse : graph.edges[id]!.reverse]));
      // A self-loop's physical order cannot distinguish its two directions.
      if (seedOrder.length === 1) orientation.set(anchor, false);
      family = { id: `family-${hash(JSON.stringify(candidate.core.key))}`, common: new Set(candidate.core.trails),
        combined: new Set(candidate.core.trails), order: candidate.core.order, orientation, candidates: [] };
      families.push(family);
    }
    family.candidates.push(candidate);
    if (++work % 256 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); if (progress) await onProgress?.(progress); }
  }
  const result: SolvedRoute[] = [];
  const rank = { trailhead: 0, parking: 1, 'road-contact': 2 };
  for (const family of families) {
    const anchor = [...family.common].sort((a, b) => a - b)[0]!;
    const retained = new Map<string, SolvedRoute>();
    for (const { route, core } of family.candidates) {
      const edge = graph.edges[core.edges.find(id => graph.edges[id]!.trail === anchor)!]!;
      const direction = edge.reverse === family.orientation.get(anchor) ? 0 : 1;
      const key = `${route.start}:${direction}`;
      const previous = retained.get(key);
      if (!previous || quality(graph, route, previous.route) < 0) retained.set(key, { route, groupId: family.id, direction, preferred: false });
    }
    const choices = [...retained.values()];
    choices.sort((a, b) => rank[graph.starts[a.route.start]!.kind] - rank[graph.starts[b.route.start]!.kind]
      || quality(graph, a.route, b.route) || graph.starts[a.route.start]!.id.localeCompare(graph.starts[b.route.start]!.id));
    choices[0]!.preferred = true;
    const walks = new Map(choices.map(choice => [walkKey(graph, choice.route), choice.route.id]));
    for (const choice of choices) choice.reverseId = walks.get(walkKey(graph, choice.route, true));
    result.push(...choices);
  }
  return result;
}
