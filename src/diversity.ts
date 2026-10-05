import { createHash } from 'node:crypto';
import { search, validateQuery } from './engine/search.js';
import type { RouteCandidate, SearchProgress, SearchQuery, TrailGraph } from './model.js';

export type SolvedRoute = { route: RouteCandidate; groupId: string; direction: 0 | 1; reverseId?: string; oppositeId?: string; preferred: boolean };
type Core = { edges: number[]; trails: Set<number>; order: number[]; key: number[] };
type Witnesses = [RouteCandidate | undefined, RouteCandidate | undefined];
type Family = { id: string; position: number; common: Set<number>; combined: Set<number>; order: number[];
  orientation: Map<number, boolean>; starts: Map<number, Map<number, Witnesses>> };
type RoadChoice = { road: number; best?: RouteCandidate; extras?: Map<string, RouteCandidate> };
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

/** Complete a section privately. Minimums follow every legal road substitution;
 * only the final family/start/direction witnesses leave this module. */
export async function solveSection(graph: TrailGraph, query: SearchQuery,
  onProgress?: (progress: SearchProgress) => void | Promise<void>): Promise<SolvedRoute[]> {
  validateQuery(query);
  query = { ...query, sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], roads: query.roads && { ...query.roads } };
  const alternatives = new Map<string, { known?: RoadChoice; unknown?: RoadChoice }>();
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
    const trailSteps = route.edges.filter(id => !graph.edges[id]!.connector);
    if (!trailSteps.length) continue;
    route.id = `route-${hash(walkKey(graph, route))}`;
    // Delimited physical IDs and direction flags keep exact itineraries compact.
    const key = `${route.start}:${trailSteps.map(id => {
      const edge = graph.edges[id]!;
      return `${edge.trail.toString(36)}${edge.reverse ? 'r' : 'f'}`;
    }).join('.')}`;
    let choices = alternatives.get(key);
    if (!choices) { choices = {}; alternatives.set(key, choices); }
    const certainty = route.uncertain ? 'unknown' : 'known';
    let choice = choices[certainty];
    if (!choice || route.roadDistance < choice.road) choices[certainty] = choice = { road: route.roadDistance };
    if (route.roadDistance !== choice.road || !qualifies(route)) continue;
    const [first, last] = cycleRange(graph, route);
    let coreTrail = false;
    for (let part = first; part <= last; part++) if (!graph.edges[route.edges[part]!]!.connector) { coreTrail = true; break; }
    if (coreTrail) {
      if (!choice.best || quality(graph, route, choice.best) < 0) choice.best = route;
    } else {
      // Both directions of a road circuit have the same trail-stem itinerary.
      // Share the minimum-road facts while preserving their separate witnesses.
      const core = coreOf(graph, route), anchor = core.key[0]!;
      const keeper = JSON.stringify([core.key, graph.edges[core.edges.find(id => graph.edges[id]!.trail === anchor)!]!.reverse]);
      choice.extras ??= new Map();
      const previous = choice.extras.get(keeper);
      if (!previous || quality(graph, route, previous) < 0) choice.extras.set(keeper, route);
    }
  }
  const batches = new Map<string, { core: Core; routes: RouteCandidate[] }>();
  function retain(route: RouteCandidate) {
    const core = coreOf(graph, route), key = JSON.stringify(core.key);
    const prior = batches.get(key);
    if (prior) prior.routes.push(route);
    else batches.set(key, { core, routes: [route] });
  }
  for (const { known, unknown } of alternatives.values()) {
    for (const choice of [known, unknown && (!known || known.road >= unknown.road) ? unknown : undefined]) {
      if (choice?.best) retain(choice.best);
      for (const route of choice?.extras?.values() ?? []) retain(route);
    }
  }
  alternatives.clear();
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
  for (const batch of [...batches.values()].sort((a, b) => compareNumbers(a.core.key, b.core.key))) {
    const { core } = batch;
    const possible = new Set<Family>();
    for (const trail of core.trails) for (const family of incidentFamilies.get(trail) ?? []) possible.add(family);
    let family: Family | undefined;
    for (const choice of [...possible].sort((a, b) => a.position - b.position)) {
      const merged = merge(choice, core);
      if (!merged) continue;
      family = choice;
      for (const trail of family.common) if (!merged.common.has(trail)) {
        incidentFamilies.get(trail)!.delete(family);
        for (const options of family.starts.values()) options.delete(trail);
      }
      Object.assign(family, merged);
      break;
    }
    if (!family) {
      const seedOrder = core.edges.map(id => graph.edges[id]!.trail), canonicalOrder = canonical(seedOrder);
      const anchor = canonicalOrder[0]!, position = seedOrder.indexOf(anchor);
      const forward = [...seedOrder.slice(position), ...seedOrder.slice(0, position)];
      const reversed = seedOrder.length < 3 ? graph.edges[core.edges[position]!]!.reverse : compareNumbers(forward, canonicalOrder) !== 0;
      const orientation = new Map(core.edges.map(id => [graph.edges[id]!.trail,
        reversed ? !graph.edges[id]!.reverse : graph.edges[id]!.reverse]));
      family = { id: `family-${hash(JSON.stringify(core.key))}`, position: families.length, common: new Set(core.trails),
        combined: new Set(core.trails), order: core.order, orientation, starts: new Map() };
      families.push(family);
      for (const trail of family.common) {
        let choices = incidentFamilies.get(trail);
        if (!choices) { choices = new Set(); incidentFamilies.set(trail, choices); }
        choices.add(family);
      }
    }
    for (const route of batch.routes) {
      const [first, last] = cycleRange(graph, route);
      let options = family.starts.get(route.start);
      if (!options) { options = new Map(); family.starts.set(route.start, options); }
      for (let part = first; part <= last; part++) {
        const edge = graph.edges[route.edges[part]!]!;
        if (!family.common.has(edge.trail)) continue;
        let witnesses = options.get(edge.trail);
        if (!witnesses) { witnesses = [undefined, undefined]; options.set(edge.trail, witnesses); }
        const direction = edge.reverse === family.orientation.get(edge.trail) ? 0 : 1;
        if (!witnesses[direction] || quality(graph, route, witnesses[direction]!) < 0) witnesses[direction] = route;
      }
      if (++work % 256 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); if (progress) await onProgress?.(progress); }
    }
    batch.routes.length = 0;
  }
  const result: SolvedRoute[] = [], rank = { trailhead: 0, parking: 1, 'road-contact': 2 };
  for (const family of families) {
    const anchor = [...family.common].sort((a, b) => a - b)[0]!;
    const choices: SolvedRoute[] = [];
    for (const options of family.starts.values()) for (const [direction, route] of options.get(anchor)!.entries()) {
      if (route) choices.push({ route, groupId: family.id, direction: direction as 0 | 1, preferred: false });
    }
    choices.sort((a, b) => rank[graph.starts[a.route.start]!.kind] - rank[graph.starts[b.route.start]!.kind]
      || quality(graph, a.route, b.route) || graph.starts[a.route.start]!.id.localeCompare(graph.starts[b.route.start]!.id));
    choices[0]!.preferred = true;
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
