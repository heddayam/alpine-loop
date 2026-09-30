import type { RouteCandidate, TrailGraph } from './model.js';

type Choice = { route: RouteCandidate; trails: Set<number>; length: number };

/** Select what is useful to compare; never decides whether exploration continues. */
export function createShortlist(graph: TrailGraph, maximum = 300, perStart = 10) {
  const choices: Choice[] = [];
  const physicalLengths = new Map(graph.edges.map(edge => [edge.trail, edge.distance]));
  return (route: RouteCandidate): boolean => {
    if (choices.length >= maximum) return false;
    const siblings = choices.filter(choice => choice.route.start === route.start);
    if (siblings.length >= perStart) return false;
    const trails = new Set(route.edges.map(index => graph.edges[index]!.trail));
    const length = [...trails].reduce((sum, trail) => sum + physicalLengths.get(trail)!, 0);
    // Weighted Jaccard groups reversals and tiny detours. Different substantial
    // trail choices remain separate even when distance and gain are similar.
    const similar = siblings.find(choice => {
      let shared = 0;
      for (const trail of trails) if (choice.trails.has(trail)) shared += physicalLengths.get(trail)!;
      return shared / (length + choice.length - shared) >= 0.85;
    });
    if (similar) return false;
    // Published choices stay stable while someone inspects or exports them.
    choices.push({ route, trails, length });
    return true;
  };
}
