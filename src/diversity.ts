import { createHash } from 'node:crypto';
import type { RouteCandidate, TrailGraph } from './model.js';

type Footprint = { trails: Set<number>; length: number };
type Quality = Pick<RouteCandidate, 'uncertain' | 'roadDistance' | 'distance' | 'gain'>;
type Selection = { walkId: string; quality: Quality };
type Choice = { groupId: string; full: Footprint; cycle: Footprint; starts: Map<number, Selection> };
type Identity = { groupId: string; optionId: string; walkId: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Compare hiking itineraries, then retain a qualifying connection from each start. */
export function createRouteGroups(graph: TrailGraph) {
  const choices: Choice[] = [];
  const physical = new Map(graph.edges.map(edge => [edge.trail, edge]));
  function footprint(edges: number[]): Footprint {
    const trails = new Set(edges.map(index => graph.edges[index]!).filter(edge => !edge.connector)
      .map(edge => edge.trail).sort((a, b) => a - b));
    return { trails, length: [...trails].reduce((sum, trail) => sum + physical.get(trail)!.distance, 0) };
  }
  function similar(a: Footprint, b: Footprint): boolean {
    if (!a.length || !b.length) return a.length === b.length;
    let shared = 0;
    for (const trail of a.trails) if (b.trails.has(trail)) shared += physical.get(trail)!.distance;
    const union = a.length + b.length - shared;
    if (shared / union < 0.95) return false;
    // Independent small detours should not multiply choices. Bound each connected
    // divergence, rather than their sum; keep a substantial branch even on a long hike.
    const differences = [...a.trails].filter(trail => !b.trails.has(trail))
      .concat([...b.trails].filter(trail => !a.trails.has(trail)));
    const incident = new Map<number, number[]>();
    for (const trail of differences) {
      const edge = physical.get(trail)!;
      for (const node of [edge.from, edge.to]) incident.set(node, [...(incident.get(node) ?? []), trail]);
    }
    const unseen = new Set(differences);
    for (const seed of unseen) {
      let length = 0;
      const pending = [seed];
      unseen.delete(seed);
      while (pending.length) {
        const edge = physical.get(pending.pop()!)!;
        length += edge.distance;
        if (length > 500) return false;
        for (const node of [edge.from, edge.to]) for (const trail of incident.get(node) ?? []) {
          if (unseen.delete(trail)) pending.push(trail);
        }
      }
    }
    return true;
  }
  function better(a: Quality, b: Quality): boolean {
    // Only already qualifying walks compete. Prefer mapped access, then less road walking.
    for (const difference of [Number(a.uncertain) - Number(b.uncertain),
      a.roadDistance - b.roadDistance, a.distance - b.distance, a.gain - b.gain]) {
      if (Math.abs(difference) > 1e-7) return difference < 0;
    }
    return false;
  }
  return (route: RouteCandidate): Identity | undefined => {
    let first = 0, last = route.edges.length - 1;
    while (first < last && graph.edges[route.edges[first]!]!.trail === graph.edges[route.edges[last]!]!.trail) {
      first++; last--;
    }
    const full = footprint(route.edges);
    const cycle = footprint(route.edges.slice(first, last + 1));
    let group = choices.find(choice => similar(full, choice.full) && similar(cycle, choice.cycle));
    if (!group) {
      group = { groupId: route.id, full, cycle, starts: new Map() };
      choices.push(group);
    }
    const walk = route.edges.map(index => {
      const edge = graph.edges[index]!;
      return [edge.trail, edge.reverse] as const;
    });
    const forward = JSON.stringify(walk);
    const backward = JSON.stringify(walk.toReversed().map(([trail, reverse]) => [trail, !reverse]));
    const walkId = hash(JSON.stringify([graph.starts[route.start]!.id, forward < backward ? forward : backward]));
    const previous = group.starts.get(route.start);
    if (previous?.walkId !== walkId && previous && !better(route, previous.quality)) return;
    if (!previous || better(route, previous.quality)) group.starts.set(route.start, { walkId, quality: {
      uncertain: route.uncertain, roadDistance: route.roadDistance, distance: route.distance, gain: route.gain,
    } });
    return { groupId: group.groupId, optionId: hash(JSON.stringify([group.groupId, graph.starts[route.start]!.id])), walkId };
  };
}
