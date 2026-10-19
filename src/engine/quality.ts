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

/** FNV-1a: a stable 32-bit identity for geometry text. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  return hash >>> 0;
}
const identities = new WeakMap<TrailGraph, Map<number, number>>();
/** Trail identity from its end positions and length, independent of how preparation numbered trails. */
export function trailIdentity(graph: TrailGraph, trail: number): number {
  let known = identities.get(graph);
  if (!known) {
    known = new Map();
    const twins = new Map<string, number[]>();
    for (const edge of graph.edges) if (!known.has(edge.trail)) {
      const ends = [edge.from, edge.to].map(node => graph.nodes[node]!.slice(0, 2).join(',')).sort();
      const text = `${ends.join(';')};${Math.round(edge.distance)}`;
      known.set(edge.trail, 0);
      twins.set(text, [...twins.get(text) ?? [], edge.trail]);
    }
    // Parallel trails with the same ends and length still need distinct identities.
    for (const [text, trails] of twins) trails.sort((a, b) => a - b)
      .forEach((trail, rank) => known!.set(trail, stableHash(rank ? `${text}#${rank}` : text)));
    identities.set(graph, known);
  }
  return known.get(trail)!;
}

export function walkKey(graph: TrailGraph, route: RouteCandidate, reverse = false): string {
  const steps: string[] = [];
  for (let at = 0; at < route.edges.length; at++) {
    const edge = graph.edges[route.edges[reverse ? route.edges.length - at - 1 : at]!]!;
    steps.push(`[${trailIdentity(graph, edge.trail)},${edge.reverse !== reverse}]`);
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

export const startRank = { trailhead: 0, parking: 1, 'road-contact': 2 };
export function preference(graph: TrailGraph, a: RouteCandidate, b: RouteCandidate): number {
  return startRank[graph.starts[a.start]!.kind] - startRank[graph.starts[b.start]!.kind]
    || quality(graph, a, b) || graph.starts[a.start]!.id.localeCompare(graph.starts[b.start]!.id);
}
