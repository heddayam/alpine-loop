export type AccessState = "public" | "unknown" | "private" | "closed" | "prohibited";

export type GraphNode = {
  id: string;
  lon: number;
  lat: number;
  elevationMeters: number | null;
  flags: string[];
};

export type GraphEdge = {
  id: string;
  /** Stable schema-3 directed edge identity; absent on legacy packs and synthetic fixtures. */
  edgeKey?: number;
  /** Stable schema-3 undirected physical identity; absent on legacy packs and synthetic fixtures. */
  physicalEdgeKey?: number;
  fromNodeId: string;
  toNodeId: string;
  coordinates: Array<readonly [number, number]>;
  lengthMeters: number;
  gainMeters: number;
  lossMeters: number;
  maximumElevationMeters: number | null;
  maximumSustainedGradePct: number | null;
  accessState: AccessState;
  trailName: string | null;
  sourceIds: string[];
  flags: string[];
};

export type GraphAccessPoint = {
  id: string;
  nodeId: string;
  name: string;
  kind: "trailhead" | "parking" | "transit";
  accessState: AccessState;
  confidence: "high" | "medium" | "low";
  parkingEvidence: string | null;
  sourceIds: string[];
  /**
   * Measured remoteness inputs. Null on packs built before the population
   * source existed, or built without one, which classify as "unknown".
   */
  populationWithinRadius: number | null;
  localReliefM: number | null;
};

export type InducedGraph = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  accessPoints: GraphAccessPoint[];
};
