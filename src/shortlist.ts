import type { RouteCandidate, TrailGraph } from './model.js';

type Footprint = { trails: Set<number>; length: number };
type Choice = { full: Footprint; cycle: Footprint };

/** Select what is useful to compare; never decides whether exploration continues. */
export function createShortlist(graph: TrailGraph, perStart = 10) {
  const choices = new Map<number, Choice[]>();
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
  return (route: RouteCandidate): boolean => {
    const siblings = choices.get(route.start) ?? [];
    if (siblings.length >= perStart) return false;
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
    if (siblings.some(choice => similar(full, choice.full) && similar(cycle, choice.cycle))) return false;
    // Published choices stay stable while someone inspects or exports them.
    siblings.push({ full, cycle });
    choices.set(route.start, siblings);
    return true;
  };
}
