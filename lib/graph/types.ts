import type { GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "./types-internal";
import type { AreaGeometry, BoundingBox } from "./geometry";

export type {
  AccessTopology,
  ReconstructedDirectedEdge,
} from "./closed-route-topology";

export type { AccessState, EdgeClass, GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "./types-internal";

export type GraphQuery = {
  bbox: readonly [west: number, south: number, east: number, north: number];
  includeUncertainAccess: boolean;
  signal?: AbortSignal;
};

export type AccessPointCandidate = GraphAccessPoint & {
  lon: number;
  lat: number;
  knownConnectivity: number;
  inclusiveConnectivity: number;
  knownOutDegree: number;
  inclusiveOutDegree: number;
  reachableTrailKm?: number;
  trailComponentId?: string | null;
  portalRoadClass?: "street" | "service-road" | null;
  parkingDistanceM?: number | null;
};

export type AccessPointCandidateQuery = {
  bbox: BoundingBox;
  includeUncertainAccess: boolean;
  signal?: AbortSignal;
};

export type ReachableGraphQuery = {
  startNodeId: string;
  maximumDistanceMeters: number;
  maximumDirectedEdges: number;
  includeUncertainAccess: boolean;
  coverage: AreaGeometry;
  signal?: AbortSignal;
};

export type ReachableGraphResult = {
  graph: InducedGraph;
  truncated: boolean;
};

export interface GraphRepository {
  readonly packId: string;
  getInducedGraph(query: GraphQuery): Promise<InducedGraph>;
  getAccessPoints(bbox: GraphQuery["bbox"], includeUncertainAccess: boolean): Promise<GraphAccessPoint[]>;
  getAccessPointCandidates(query: AccessPointCandidateQuery): Promise<AccessPointCandidate[]>;
  getReachableGraph(query: ReachableGraphQuery): Promise<ReachableGraphResult>;
  close(): Promise<void>;
}

export type EdgeTraversal = { edge: GraphEdge; from: GraphNode; to: GraphNode };
