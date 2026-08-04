import { edgeIsInsideBbox, lineLengthMeters, nodeIsInsideBbox } from "./geometry";
import { accessPointIsEligible, edgeIsTraversable } from "./policy";
import type {
  AccessState,
  GraphAccessPoint,
  GraphEdge,
  GraphNode,
  GraphQuery,
  GraphRepository,
  InducedGraph,
} from "./types";

type FixtureTrail = readonly [fromNodeId: string, toNodeId: string, trailName?: string];

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
  for (const [index, [fromNodeId, toNodeId, trailName]] of (data.undirectedTrails ?? []).entries()) {
    const forward = materializeDirectedEdge(
      { id: `fixture-trail-${index}:forward`, fromNodeId, toNodeId, trailName: trailName ?? null },
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

  async close(): Promise<void> {}
}
