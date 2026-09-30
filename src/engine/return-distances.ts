import type { TrailGraph } from '../model.js';

/** Directed reverse Dijkstra. Every legal completion is a path back to the
 * start, so this unrestricted shortest path is a lower bound, never a required
 * stem. Yield for each examined edge so preparation also shares the work budget. */
export function* returnDistances(
  graph: TrailGraph, incoming: readonly number[][], start: number, maximum: number,
): Generator<undefined, Float64Array> {
  const distances = new Float64Array(graph.nodes.length).fill(Infinity);
  distances[start] = 0;
  const heap: Array<{ node: number; distance: number }> = [{ node: start, distance: 0 }];
  while (heap.length) {
    const current = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]!.distance < heap[child]!.distance) child++;
        if (last.distance <= heap[child]!.distance) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
    }
    if (current.distance !== distances[current.node]) continue;
    for (const id of incoming[current.node]!) {
      const edge = graph.edges[id]!;
      const distance = current.distance + edge.distance;
      if (distance < distances[edge.from]! && distance <= maximum) {
        distances[edge.from] = distance;
        const next = { node: edge.from, distance };
        let index = heap.length;
        heap.push(next);
        while (index > 0) {
          const parent = (index - 1) >> 1;
          if (heap[parent]!.distance <= distance) break;
          heap[index] = heap[parent]!;
          index = parent;
        }
        heap[index] = next;
      }
      yield undefined;
    }
  }
  return distances;
}
