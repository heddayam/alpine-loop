import { edgeIsInsideBbox, lineIsInsideArea, lineLengthMeters, nodeIsInsideBbox } from "./geometry";
import { accessPointIsEligible, edgeIsTraversable } from "./policy";
import type {
  AccessState,
  AccessPointCandidate,
  AccessPointCandidateQuery,
  GraphAccessPoint,
  GraphEdge,
  GraphNode,
  GraphQuery,
  GraphRepository,
  InducedGraph,
  ReachableGraphQuery,
  ReachableGraphResult,
} from "./types";

type FixtureTrail = readonly [
  fromNodeId: string,
  toNodeId: string,
  trailName?: string,
  coordinates?: Array<readonly [number, number]>,
  sourceId?: string,
];

type FixtureDirectedEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  coordinates?: Array<readonly [number, number]>;
  lengthMeters?: number;
  gainMeters?: number;
  lossMeters?: number;
  maximumElevationMeters?: number | null;
  maximumSustainedGradePct?: number | null;
  accessState?: AccessState;
  trailName?: string | null;
  sourceIds?: string[];
  flags?: string[];
};

export type FixtureGraphData = {
  packId: string;
  nodes: GraphNode[];
  undirectedTrails?: FixtureTrail[];
  directedEdges?: FixtureDirectedEdge[];
  accessPoints: GraphAccessPoint[];
};

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Graph query was cancelled", "AbortError");
}

function reverseCoordinates(coordinates: Array<readonly [number, number]>): Array<readonly [number, number]> {
  return [...coordinates].reverse();
}

function deriveElevationMetrics(
  from: GraphNode,
  to: GraphNode,
): Pick<GraphEdge, "gainMeters" | "lossMeters" | "maximumElevationMeters"> {
  if (from.elevationMeters === null || to.elevationMeters === null) {
    return { gainMeters: 0, lossMeters: 0, maximumElevationMeters: null };
  }
  const delta = to.elevationMeters - from.elevationMeters;
  return {
    gainMeters: Math.max(0, delta),
    lossMeters: Math.max(0, -delta),
    maximumElevationMeters: Math.max(from.elevationMeters, to.elevationMeters),
  };
}

function materializeDirectedEdge(edge: FixtureDirectedEdge, nodes: Map<string, GraphNode>): GraphEdge {
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  if (!from || !to) throw new Error(`Fixture edge ${edge.id} references an unknown node`);
  const coordinates = edge.coordinates ?? [[from.lon, from.lat], [to.lon, to.lat]];
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (
    coordinates.length < 2 ||
    first?.[0] !== from.lon || first[1] !== from.lat ||
    last?.[0] !== to.lon || last[1] !== to.lat
  ) {
    throw new Error(`Fixture edge ${edge.id} geometry must start and end at its referenced nodes`);
  }
  const elevation = deriveElevationMetrics(from, to);
  return {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    coordinates,
    lengthMeters: edge.lengthMeters ?? lineLengthMeters(coordinates),
    gainMeters: edge.gainMeters ?? elevation.gainMeters,
    lossMeters: edge.lossMeters ?? elevation.lossMeters,
    maximumElevationMeters: edge.maximumElevationMeters ?? elevation.maximumElevationMeters,
    maximumSustainedGradePct: edge.maximumSustainedGradePct ?? null,
    accessState: edge.accessState ?? "public",
    trailName: edge.trailName ?? null,
    sourceIds: edge.sourceIds ?? ["fixture-source"],
    flags: edge.flags ?? [],
  };
}

function materializeEdges(data: FixtureGraphData, nodes: Map<string, GraphNode>): GraphEdge[] {
  const directed = (data.directedEdges ?? []).map((edge) => materializeDirectedEdge(edge, nodes));
  for (const [index, [fromNodeId, toNodeId, trailName, coordinates, sourceId]] of (data.undirectedTrails ?? []).entries()) {
    const forward = materializeDirectedEdge(
      {
        id: `fixture-trail-${index}:forward`,
        fromNodeId,
        toNodeId,
        trailName: trailName ?? null,
        coordinates,
        sourceIds: [sourceId ?? "fixture-source"],
      },
      nodes,
    );
    directed.push(forward, {
      ...forward,
      id: `fixture-trail-${index}:reverse`,
      fromNodeId: toNodeId,
      toNodeId: fromNodeId,
      coordinates: reverseCoordinates(forward.coordinates),
      gainMeters: forward.lossMeters,
      lossMeters: forward.gainMeters,
    });
  }
  return directed.sort((left, right) => left.id.localeCompare(right.id));
}

export class FixtureGraphRepository implements GraphRepository {
  readonly packId: string;
  readonly #nodes: Map<string, GraphNode>;
  readonly #edges: GraphEdge[];
  readonly #accessPoints: GraphAccessPoint[];

  constructor(data: FixtureGraphData) {
    this.packId = data.packId;
    this.#nodes = new Map(data.nodes.map((node) => [node.id, { ...node, flags: [...node.flags] }]));
    if (this.#nodes.size !== data.nodes.length) throw new Error("Fixture node IDs must be unique");
    this.#edges = materializeEdges(data, this.#nodes);
    this.#accessPoints = data.accessPoints.map((accessPoint) => ({ ...accessPoint }));
  }

  async getInducedGraph(query: GraphQuery): Promise<InducedGraph> {
    assertNotAborted(query.signal);
    const nodes = new Map(
      [...this.#nodes].filter(([, node]) => nodeIsInsideBbox(node, query.bbox)),
    );
    const edges = this.#edges.filter((edge) => {
      assertNotAborted(query.signal);
      return (
        nodes.has(edge.fromNodeId) &&
        nodes.has(edge.toNodeId) &&
        edgeIsInsideBbox(edge, query.bbox) &&
        edgeIsTraversable(edge, query.includeUncertainAccess)
      );
    });
    const accessPoints = this.#accessPoints.filter(
      (accessPoint) =>
        nodes.has(accessPoint.nodeId) && accessPointIsEligible(accessPoint, query.includeUncertainAccess),
    );
    return { nodes, edges, accessPoints };
  }

  async getAccessPoints(
    bbox: GraphQuery["bbox"],
    includeUncertainAccess: boolean,
  ): Promise<GraphAccessPoint[]> {
    return this.#accessPoints.filter((accessPoint) => {
      const node = this.#nodes.get(accessPoint.nodeId);
      return Boolean(node && nodeIsInsideBbox(node, bbox) && accessPointIsEligible(accessPoint, includeUncertainAccess));
    });
  }

  async getAccessPointCandidates(query: AccessPointCandidateQuery): Promise<AccessPointCandidate[]> {
    assertNotAborted(query.signal);
    const eligibleEdges = this.#edges.filter((edge) => edgeIsTraversable(edge, query.includeUncertainAccess));
    const adjacency = new Map<string, Set<string>>();
    const outDegree = new Map<string, number>();
    for (const edge of eligibleEdges) {
      const neighbors = adjacency.get(edge.fromNodeId) ?? new Set<string>();
      neighbors.add(edge.toNodeId);
      adjacency.set(edge.fromNodeId, neighbors);
      const reverse = adjacency.get(edge.toNodeId) ?? new Set<string>();
      reverse.add(edge.fromNodeId);
      adjacency.set(edge.toNodeId, reverse);
      outDegree.set(edge.fromNodeId, (outDegree.get(edge.fromNodeId) ?? 0) + 1);
    }
    const componentSizes = new Map<string, number>();
    const componentSize = (nodeId: string) => {
      const known = componentSizes.get(nodeId);
      if (known !== undefined) return known;
      const visited = new Set([nodeId]);
      const pending = [nodeId];
      while (pending.length > 0) {
        for (const neighbor of adjacency.get(pending.pop()!) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
      for (const id of visited) componentSizes.set(id, visited.size);
      return visited.size;
    };
    return this.#accessPoints.flatMap((point) => {
      assertNotAborted(query.signal);
      const node = this.#nodes.get(point.nodeId);
      if (
        !node || !nodeIsInsideBbox(node, query.bbox) ||
        !accessPointIsEligible(point, query.includeUncertainAccess)
      ) return [];
      const connectivity = componentSize(point.nodeId);
      const degree = outDegree.get(point.nodeId) ?? 0;
      return [{
        ...point,
        lon: node.lon,
        lat: node.lat,
        knownConnectivity: connectivity,
        inclusiveConnectivity: connectivity,
        knownOutDegree: degree,
        inclusiveOutDegree: degree,
      }];
    });
  }

  async getReachableGraph(query: ReachableGraphQuery): Promise<ReachableGraphResult> {
    assertNotAborted(query.signal);
    const start = this.#nodes.get(query.startNodeId);
    if (!start) return { graph: { nodes: new Map(), edges: [], accessPoints: [] }, truncated: false };
    const adjacency = new Map<string, GraphEdge[]>();
    for (const edge of this.#edges) {
      if (!edgeIsTraversable(edge, query.includeUncertainAccess) || !lineIsInsideArea(edge.coordinates, query.coverage)) continue;
      const edges = adjacency.get(edge.fromNodeId) ?? [];
      edges.push(edge);
      adjacency.set(edge.fromNodeId, edges);
    }
    for (const edges of adjacency.values()) edges.sort((left, right) => left.id.localeCompare(right.id));
    const distances = new Map<string, number>([[start.id, 0]]);
    const pending: Array<{ nodeId: string; distance: number }> = [{ nodeId: start.id, distance: 0 }];
    const edges: GraphEdge[] = [];
    const edgeIds = new Set<string>();
    let truncated = false;
    while (pending.length > 0) {
      assertNotAborted(query.signal);
      pending.sort((left, right) => left.distance - right.distance || left.nodeId.localeCompare(right.nodeId));
      const current = pending.shift()!;
      if (current.distance !== distances.get(current.nodeId)) continue;
      for (const edge of adjacency.get(current.nodeId) ?? []) {
        const nextDistance = current.distance + edge.lengthMeters;
        if (nextDistance > query.maximumDistanceMeters) continue;
        if (!edgeIds.has(edge.id)) {
          if (edges.length >= query.maximumDirectedEdges) {
            truncated = true;
            break;
          }
          edgeIds.add(edge.id);
          edges.push(edge);
        }
        const previous = distances.get(edge.toNodeId);
        if (previous === undefined || nextDistance < previous) {
          distances.set(edge.toNodeId, nextDistance);
          pending.push({ nodeId: edge.toNodeId, distance: nextDistance });
        }
      }
      if (truncated) break;
    }
    const nodeIds = new Set<string>([start.id]);
    for (const edge of edges) {
      nodeIds.add(edge.fromNodeId);
      nodeIds.add(edge.toNodeId);
    }
    return {
      graph: {
        nodes: new Map([...this.#nodes].filter(([id]) => nodeIds.has(id))),
        edges,
        accessPoints: this.#accessPoints.filter(
          (point) => nodeIds.has(point.nodeId) && accessPointIsEligible(point, query.includeUncertainAccess),
        ),
      },
      truncated,
    };
  }

  async close(): Promise<void> {}
}
