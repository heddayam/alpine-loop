import type {
  EdgeTraversal,
  GraphAccessPoint,
  GraphEdge,
  GraphNode,
  InducedGraph,
} from "@/lib/graph";

/**
 * A directed search edge backed by the exact ordered traversals from the pack.
 *
 * The aggregate edge is useful for target-directed search and pruning. Route
 * candidates must be reconstructed with `expandCompressedPath` before scoring,
 * so canonical IDs, repeated-edge accounting, geometry, and provenance remain
 * based on the original graph.
 */
export type CompressedEdgeTraversal = EdgeTraversal & {
  originalTraversals: readonly EdgeTraversal[];
  hasIncompleteElevation: boolean;
  hasIncompleteGrade: boolean;
};

export type CompressedSearchGraph = {
  /** Decision, endpoint, cycle-anchor, and access-point nodes. */
  nodes: Map<string, GraphNode>;
  traversals: CompressedEdgeTraversal[];
  adjacency: Map<string, CompressedEdgeTraversal[]>;
  accessPoints: GraphAccessPoint[];
  originalDirectedEdgeCount: number;
};

type Incidence = {
  neighbors: Set<string>;
  incomingByNeighbor: Map<string, GraphEdge[]>;
  outgoingByNeighbor: Map<string, GraphEdge[]>;
};

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return (
    left.id.localeCompare(right.id) ||
    left.fromNodeId.localeCompare(right.fromNodeId) ||
    left.toNodeId.localeCompare(right.toNodeId)
  );
}

function compareTraversals(left: CompressedEdgeTraversal, right: CompressedEdgeTraversal): number {
  return left.edge.id.localeCompare(right.edge.id);
}

function addToMapList(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const values = map.get(key) ?? [];
  values.push(edge);
  map.set(key, values);
}

function buildIncidence(graph: InducedGraph): Map<string, Incidence> {
  const incidence = new Map<string, Incidence>();
  for (const nodeId of graph.nodes.keys()) {
    incidence.set(nodeId, {
      neighbors: new Set(),
      incomingByNeighbor: new Map(),
      outgoingByNeighbor: new Map(),
    });
  }

  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.fromNodeId) || !graph.nodes.has(edge.toNodeId)) {
      throw new Error(`Edge ${edge.id} references a node outside the induced graph`);
    }
    const from = incidence.get(edge.fromNodeId)!;
    const to = incidence.get(edge.toNodeId)!;
    from.neighbors.add(edge.toNodeId);
    to.neighbors.add(edge.fromNodeId);
    addToMapList(from.outgoingByNeighbor, edge.toNodeId, edge);
    addToMapList(to.incomingByNeighbor, edge.fromNodeId, edge);
  }

  return incidence;
}

/**
 * Degree two alone is insufficient for directed graphs. A node is safe to
 * suppress only when arrivals from either side map one-to-one to departures on
 * the other side. Parallel alternatives, turnarounds, and asymmetric breaks
 * remain explicit decisions.
 */
function isCompressibleNode(nodeId: string, incidence: Map<string, Incidence>): boolean {
  const entry = incidence.get(nodeId)!;
  if (entry.neighbors.size !== 2 || entry.neighbors.has(nodeId)) return false;
  const [left, right] = [...entry.neighbors].sort();
  const incomingLeft = entry.incomingByNeighbor.get(left)?.length ?? 0;
  const incomingRight = entry.incomingByNeighbor.get(right)?.length ?? 0;
  const outgoingLeft = entry.outgoingByNeighbor.get(left)?.length ?? 0;
  const outgoingRight = entry.outgoingByNeighbor.get(right)?.length ?? 0;

  if ([incomingLeft, incomingRight, outgoingLeft, outgoingRight].some((count) => count > 1)) {
    return false;
  }
  return incomingLeft === outgoingRight && incomingRight === outgoingLeft;
}

function retainCycleAnchors(
  graph: InducedGraph,
  incidence: Map<string, Incidence>,
  retained: Set<string>,
): void {
  const visited = new Set<string>();
  const nodeIds = [...graph.nodes.keys()].sort();
  for (const seed of nodeIds) {
    if (visited.has(seed)) continue;
    const component: string[] = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      component.push(nodeId);
      for (const neighbor of [...incidence.get(nodeId)!.neighbors].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    if (!component.some((nodeId) => retained.has(nodeId))) {
      retained.add(component.sort()[0]!);
    }
  }
}

function nextEdgeThrough(
  nodeId: string,
  previousNodeId: string,
  incidence: Map<string, Incidence>,
): GraphEdge | undefined {
  const entry = incidence.get(nodeId)!;
  const otherNeighbor = [...entry.neighbors].find((neighbor) => neighbor !== previousNodeId);
  if (!otherNeighbor) return undefined;
  const outgoing = entry.outgoingByNeighbor.get(otherNeighbor) ?? [];
  return outgoing.length === 1 ? outgoing[0] : undefined;
}

function stableCompressedId(traversals: readonly EdgeTraversal[]): string {
  const encodedIds = traversals.map(({ edge }) => `${edge.id.length}:${edge.id}`).join("|");
  return `compressed:${encodedIds}`;
}

function appendCoordinates(
  traversals: readonly EdgeTraversal[],
): Array<readonly [number, number]> {
  const coordinates: Array<readonly [number, number]> = [];
  for (const [index, traversal] of traversals.entries()) {
    coordinates.push(...(index === 0 ? traversal.edge.coordinates : traversal.edge.coordinates.slice(1)));
  }
  return coordinates;
}

const ACCESS_RESTRICTIVENESS: Record<GraphEdge["accessState"], number> = {
  public: 0,
  unknown: 1,
  private: 2,
  closed: 3,
  prohibited: 4,
};

function aggregateEdge(traversals: readonly EdgeTraversal[]): GraphEdge {
  const first = traversals[0]!;
  const last = traversals[traversals.length - 1]!;
  const elevations = traversals.map(({ edge }) => edge.maximumElevationMeters);
  const grades = traversals.map(({ edge }) => edge.maximumSustainedGradePct);
  const names = [...new Set(traversals.map(({ edge }) => edge.trailName))];
  const accessState = traversals
    .map(({ edge }) => edge.accessState)
    .sort((left, right) => ACCESS_RESTRICTIVENESS[right] - ACCESS_RESTRICTIVENESS[left])[0]!;

  return {
    id: stableCompressedId(traversals),
    fromNodeId: first.from.id,
    toNodeId: last.to.id,
    coordinates: appendCoordinates(traversals),
    lengthMeters: traversals.reduce((sum, { edge }) => sum + edge.lengthMeters, 0),
    gainMeters: traversals.reduce((sum, { edge }) => sum + edge.gainMeters, 0),
    lossMeters: traversals.reduce((sum, { edge }) => sum + edge.lossMeters, 0),
    maximumElevationMeters: elevations.some((value) => value === null)
      ? null
      : Math.max(...(elevations as number[])),
    maximumSustainedGradePct: grades.some((value) => value === null)
      ? null
      : Math.max(...(grades as number[])),
    accessState,
    trailName: names.length === 1 ? names[0]! : null,
    sourceIds: [...new Set(traversals.flatMap(({ edge }) => edge.sourceIds))].sort(),
    flags: [...new Set(traversals.flatMap(({ edge }) => edge.flags))].sort(),
  };
}

function materializeCompressedTraversal(originalTraversals: readonly EdgeTraversal[]): CompressedEdgeTraversal {
  const edge = aggregateEdge(originalTraversals);
  return {
    edge,
    from: originalTraversals[0]!.from,
    to: originalTraversals[originalTraversals.length - 1]!.to,
    originalTraversals: [...originalTraversals],
    hasIncompleteElevation: originalTraversals.some(
      ({ edge, from, to }) =>
        edge.maximumElevationMeters === null ||
        from.elevationMeters === null ||
        to.elevationMeters === null,
    ),
    hasIncompleteGrade: originalTraversals.some(
      ({ edge }) => edge.maximumSustainedGradePct === null,
    ),
  };
}

/**
 * Compresses non-branching graph chains without changing route semantics.
 * Every original directed edge occurs in exactly one compressed traversal.
 */
export function compressSearchGraph(graph: InducedGraph): CompressedSearchGraph {
  const incidence = buildIncidence(graph);
  const accessNodeIds = new Set(graph.accessPoints.map(({ nodeId }) => nodeId));
  for (const nodeId of accessNodeIds) {
    if (!graph.nodes.has(nodeId)) throw new Error(`Access point references missing node ${nodeId}`);
  }

  const retained = new Set<string>();
  for (const nodeId of [...graph.nodes.keys()].sort()) {
    if (accessNodeIds.has(nodeId) || !isCompressibleNode(nodeId, incidence)) retained.add(nodeId);
  }
  retainCycleAnchors(graph, incidence, retained);

  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of [...graph.edges].sort(compareEdges)) {
    addToMapList(outgoing, edge.fromNodeId, edge);
  }
  const consumed = new Set<GraphEdge>();
  const traversals: CompressedEdgeTraversal[] = [];

  for (const startNodeId of [...retained].sort()) {
    for (const firstEdge of outgoing.get(startNodeId) ?? []) {
      if (consumed.has(firstEdge)) continue;
      const path: EdgeTraversal[] = [];
      let edge = firstEdge;
      while (true) {
        if (consumed.has(edge)) {
          throw new Error(`Directed edge ${edge.id} belongs to more than one compressed chain`);
        }
        consumed.add(edge);
        const from = graph.nodes.get(edge.fromNodeId)!;
        const to = graph.nodes.get(edge.toNodeId)!;
        path.push({ edge, from, to });
        if (retained.has(to.id)) break;
        const continuation = nextEdgeThrough(to.id, from.id, incidence);
        if (!continuation) {
          throw new Error(`Compressible node ${to.id} has no unique directed continuation`);
        }
        edge = continuation;
      }
      traversals.push(materializeCompressedTraversal(path));
    }
  }

  if (consumed.size !== graph.edges.length) {
    throw new Error(`Compression retained ${consumed.size} of ${graph.edges.length} directed edges`);
  }

  traversals.sort(compareTraversals);
  const adjacency = new Map<string, CompressedEdgeTraversal[]>();
  for (const traversal of traversals) {
    const values = adjacency.get(traversal.from.id) ?? [];
    values.push(traversal);
    adjacency.set(traversal.from.id, values);
  }
  for (const values of adjacency.values()) values.sort(compareTraversals);

  return {
    nodes: new Map(
      [...retained]
        .sort()
        .map((nodeId) => [nodeId, graph.nodes.get(nodeId)!] as const),
    ),
    traversals,
    adjacency,
    accessPoints: [...graph.accessPoints].sort((left, right) => left.id.localeCompare(right.id)),
    originalDirectedEdgeCount: graph.edges.length,
  };
}

export function expandCompressedTraversal(
  traversal: CompressedEdgeTraversal,
): EdgeTraversal[] {
  return [...traversal.originalTraversals];
}

export function expandCompressedPath(
  path: readonly CompressedEdgeTraversal[],
): EdgeTraversal[] {
  return path.flatMap(expandCompressedTraversal);
}
