import type { GenerateRoutesRequestV1 } from "@/lib/contracts";
import {
  accessPointIsEligible,
  edgeIsInsideBbox,
  edgeIsTraversable,
  type GraphAccessPoint,
  type GraphEdge,
  type InducedGraph,
} from "@/lib/graph";

const METERS_PER_MILE = 1_609.344;
const AUTOMATIC_START_LIMIT = 1;

type QueueItem = { nodeId: string; distance: number };

class DistanceQueue {
  readonly #items: QueueItem[] = [];

  push(item: QueueItem): void {
    this.#items.push(item);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.#before(this.#items[index]!, this.#items[parent]!)) break;
      [this.#items[index], this.#items[parent]] = [this.#items[parent]!, this.#items[index]!];
      index = parent;
    }
  }

  pop(): QueueItem | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (!first || !last || this.#items.length === 0) return first;
    this.#items[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < this.#items.length && this.#before(this.#items[left]!, this.#items[next]!)) next = left;
      if (right < this.#items.length && this.#before(this.#items[right]!, this.#items[next]!)) next = right;
      if (next === index) break;
      [this.#items[index], this.#items[next]] = [this.#items[next]!, this.#items[index]!];
      index = next;
    }
    return first;
  }

  get size(): number {
    return this.#items.length;
  }

  #before(left: QueueItem, right: QueueItem): boolean {
    return left.distance < right.distance
      || (left.distance === right.distance && left.nodeId.localeCompare(right.nodeId) < 0);
  }
}

export function rankEligibleStarts(graph: InducedGraph, request: GenerateRoutesRequestV1): GraphAccessPoint[] {
  const eligible = graph.accessPoints.filter((point) => accessPointIsEligible(point, request.includeUncertainAccess));
  if (request.startAccessPointId) {
    return eligible.filter(({ id }) => id === request.startAccessPointId);
  }
  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edgeIsTraversable(edge, request.includeUncertainAccess) || !edgeIsInsideBbox(edge, request.bbox)) {
      continue;
    }
    const from = neighbors.get(edge.fromNodeId) ?? [];
    from.push(edge.toNodeId);
    neighbors.set(edge.fromNodeId, from);
    const to = neighbors.get(edge.toNodeId) ?? [];
    to.push(edge.fromNodeId);
    neighbors.set(edge.toNodeId, to);
  }
  const componentSizes = new Map<string, number>();
  const outgoingDegree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edgeIsTraversable(edge, request.includeUncertainAccess) || !edgeIsInsideBbox(edge, request.bbox)) {
      continue;
    }
    outgoingDegree.set(edge.fromNodeId, (outgoingDegree.get(edge.fromNodeId) ?? 0) + 1);
  }
  const componentSize = (nodeId: string): number => {
    const known = componentSizes.get(nodeId);
    if (known !== undefined) return known;
    const visited = new Set<string>([nodeId]);
    const pending = [nodeId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const neighbor of neighbors.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    for (const id of visited) componentSizes.set(id, visited.size);
    return visited.size;
  };
  const confidence = { high: 0, medium: 1, low: 2 };
  return eligible.sort(
    (left, right) => componentSize(right.nodeId) - componentSize(left.nodeId)
      || (outgoingDegree.get(right.nodeId) ?? 0) - (outgoingDegree.get(left.nodeId) ?? 0)
      || Number(left.name.startsWith("OSM ")) - Number(right.name.startsWith("OSM "))
      || confidence[left.confidence] - confidence[right.confidence]
      || Number(Boolean(right.parkingEvidence)) - Number(Boolean(left.parkingEvidence))
      || left.id.localeCompare(right.id),
  );
}

function reachableGraph(
  graph: InducedGraph,
  starts: readonly GraphAccessPoint[],
  maximumDistanceMeters: number,
): InducedGraph {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const edges = adjacency.get(edge.fromNodeId) ?? [];
    edges.push(edge);
    adjacency.set(edge.fromNodeId, edges);
  }
  for (const edges of adjacency.values()) edges.sort((left, right) => left.id.localeCompare(right.id));

  const distances = new Map<string, number>();
  const queue = new DistanceQueue();
  for (const start of starts) {
    if (!graph.nodes.has(start.nodeId)) continue;
    distances.set(start.nodeId, 0);
    queue.push({ nodeId: start.nodeId, distance: 0 });
  }
  while (queue.size > 0) {
    const item = queue.pop()!;
    if (item.distance !== distances.get(item.nodeId)) continue;
    for (const edge of adjacency.get(item.nodeId) ?? []) {
      const nextDistance = item.distance + edge.lengthMeters;
      if (nextDistance > maximumDistanceMeters) continue;
      const previous = distances.get(edge.toNodeId);
      if (previous === undefined || nextDistance < previous) {
        distances.set(edge.toNodeId, nextDistance);
        queue.push({ nodeId: edge.toNodeId, distance: nextDistance });
      }
    }
  }

  const edges = graph.edges.filter((edge) => {
    const fromDistance = distances.get(edge.fromNodeId);
    return fromDistance !== undefined
      && fromDistance + edge.lengthMeters <= maximumDistanceMeters
      && distances.has(edge.toNodeId);
  });
  const reachableNodeIds = new Set<string>();
  for (const edge of edges) {
    reachableNodeIds.add(edge.fromNodeId);
    reachableNodeIds.add(edge.toNodeId);
  }
  for (const start of starts) reachableNodeIds.add(start.nodeId);
  return {
    nodes: new Map([...graph.nodes].filter(([id]) => reachableNodeIds.has(id))),
    edges,
    accessPoints: graph.accessPoints.filter(({ nodeId }) => reachableNodeIds.has(nodeId)),
  };
}

/**
 * Large rectangles remain hard boundaries, but edges that cannot be reached
 * within the requested route distance are irrelevant to this search. Reduce
 * only graphs that would otherwise trip the documented directed-edge guard.
 */
export function graphForRouteRequest(
  graph: InducedGraph,
  request: GenerateRoutesRequestV1,
  maximumDirectedEdges: number,
): InducedGraph {
  if (graph.edges.length <= maximumDirectedEdges) return graph;
  const starts = rankEligibleStarts(graph, request).slice(0, AUTOMATIC_START_LIMIT);
  if (starts.length === 0) return graph;
  const maximumDistanceMeters = Math.max(1, request.distanceMiles.max * METERS_PER_MILE * 1.25);
  return reachableGraph(graph, starts, maximumDistanceMeters);
}
