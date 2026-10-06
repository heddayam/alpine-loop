import type { RouteCandidate, TrailGraph } from '../model.js';

export function walkKey(graph: TrailGraph, route: RouteCandidate, reverse = false): string {
  const edges = reverse ? route.edges.toReversed() : route.edges;
  return JSON.stringify([graph.starts[route.start]!.id,
    edges.map(id => [graph.edges[id]!.trail, reverse ? !graph.edges[id]!.reverse : graph.edges[id]!.reverse])]);
}
export function quality(graph: TrailGraph, a: RouteCandidate, b: RouteCandidate): number {
  for (const difference of [Number(a.uncertain) - Number(b.uncertain), a.roadDistance - b.roadDistance,
    a.repetition - b.repetition, a.distance - b.distance]) if (difference) return difference;
  const pair = (route: RouteCandidate) => {
    const forward = walkKey(graph, route), back = walkKey(graph, route, true);
    return forward < back ? forward : back;
  };
  return pair(a).localeCompare(pair(b)) || a.id.localeCompare(b.id);
}

