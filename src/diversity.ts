import type { RouteCandidate, TrailGraph } from './model.js';

type Footprint = { trails: Set<number>; length: number };
type Choice = { groupId: string; full: Footprint; cycle: Footprint };
type Identity = { groupId: string; optionId: string };

/** Organize every qualifying route; callers retain each emitted direction and its facts. */
export function createRouteGroups(graph: TrailGraph) {
  const choices: Choice[] = [];
  const options = new Map<string, Identity>();
  const physicalLengths = new Map(graph.edges.map(edge => [edge.trail, edge.distance]));
  function footprint(edges: number[]): Footprint {
    const trails = new Set(edges.map(index => graph.edges[index]!.trail));
    return { trails, length: [...trails].reduce((sum, trail) => sum + physicalLengths.get(trail)!, 0) };
  }
  function similar(a: Footprint, b: Footprint): boolean {
    let shared = 0;
    for (const trail of a.trails) if (b.trails.has(trail)) shared += physicalLengths.get(trail)!;
    return shared / (a.length + b.length - shared) >= 0.85;
  }
  return (route: RouteCandidate): Identity => {
    const walk = route.edges.map(index => {
      const edge = graph.edges[index]!;
      return [edge.trail, edge.reverse] as const;
    });
    const forward = JSON.stringify(walk);
    const backward = JSON.stringify(walk.toReversed().map(([trail, reverse]) => [trail, !reverse]));
    const key = JSON.stringify([graph.starts[route.start]!.id, forward < backward ? forward : backward]);
    const existing = options.get(key);
    if (existing) return existing;

    // Valid lollipops have matching outbound/return stem corridors at both ends.
    let first = 0;
    let last = route.edges.length - 1;
    while (first < last && graph.edges[route.edges[first]!]!.trail === graph.edges[route.edges[last]!]!.trail) {
      first++;
      last--;
    }
    const full = footprint(route.edges);
    const cycle = footprint(route.edges.slice(first, last + 1));
    // Neither a shared approach nor a shared cycle alone makes two hikes similar.
    const group = choices.find(choice => similar(full, choice.full) && similar(cycle, choice.cycle));
    const identity = { groupId: group?.groupId ?? route.id, optionId: route.id };
    // Only first representatives define groups; later similar options never move them.
    if (!group) choices.push({ groupId: identity.groupId, full, cycle });
    options.set(key, identity);
    return identity;
  };
}
