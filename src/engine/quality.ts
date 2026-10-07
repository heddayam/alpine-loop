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
  const steps: string[] = [];
  for (let at = 0; at < route.edges.length; at++) {
    const edge = graph.edges[route.edges[reverse ? route.edges.length - at - 1 : at]!]!;
    steps.push(`[${edge.trail},${edge.reverse !== reverse}]`);
  }
  return `[${JSON.stringify(graph.starts[route.start]!.id)},[${steps.join(',')}]]`;
}
export type RouteMetrics = Pick<RouteCandidate, 'uncertain' | 'roadDistance' | 'repetition' | 'distance'>;
export function compareMetrics(a: RouteMetrics, b: RouteMetrics): number {
  return Number(a.uncertain) - Number(b.uncertain) || a.roadDistance - b.roadDistance
    || a.repetition - b.repetition || a.distance - b.distance;
}
export function quality(graph: TrailGraph, a: RouteCandidate, b: RouteCandidate): number {
  const difference = compareMetrics(a, b);
  if (difference) return difference;
  const pair = (route: RouteCandidate) => {
    const forward = walkKey(graph, route), back = walkKey(graph, route, true);
    return forward < back ? forward : back;
  };
  return pair(a).localeCompare(pair(b)) || a.id.localeCompare(b.id);
}

const startRank = { trailhead: 0, parking: 1, 'road-contact': 2 };
export function preference(graph: TrailGraph, a: RouteCandidate, b: RouteCandidate): number {
  return startRank[graph.starts[a.start]!.kind] - startRank[graph.starts[b.start]!.kind]
    || quality(graph, a, b) || graph.starts[a.start]!.id.localeCompare(graph.starts[b.start]!.id);
}
