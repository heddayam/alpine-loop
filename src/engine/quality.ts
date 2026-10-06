import type { RouteCandidate, TrailGraph } from '../model.js';

export function compareNumbers(a: number[], b: number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
/** Physical circuits contain distinct trails; rotation and reversal preserve identity. */
export function canonical(order: number[]): number[] {
  if (!order.length) return [];
  const smallest = Math.min(...order), at = order.indexOf(smallest);
  const forward = [...order.slice(at), ...order.slice(0, at)];
  const back = [forward[0]!, ...forward.slice(1).toReversed()];
  return compareNumbers(forward, back) <= 0 ? forward : back;
}

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
