import type { GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "./types-internal";

export type { AccessState, GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "./types-internal";

export type GraphQuery = {
  bbox: readonly [west: number, south: number, east: number, north: number];
  includeUncertainAccess: boolean;
  signal?: AbortSignal;
};

export interface GraphRepository {
  readonly packId: string;
  getInducedGraph(query: GraphQuery): Promise<InducedGraph>;
  getAccessPoints(bbox: GraphQuery["bbox"], includeUncertainAccess: boolean): Promise<GraphAccessPoint[]>;
  close(): Promise<void>;
}

export type EdgeTraversal = { edge: GraphEdge; from: GraphNode; to: GraphNode };
