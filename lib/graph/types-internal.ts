export type AccessState = "public" | "unknown" | "private" | "closed" | "prohibited";
export type EdgeClass = "trail" | "service-road" | "street" | "sidewalk";

export type GraphNode = {
  id: string;
  lon: number;
  lat: number;
  elevationMeters: number | null;
  flags: string[];
};

export type GraphEdge = {
  id: string;
  /** Stable directed edge identity. Optional only for in-memory algorithm fixtures. */
  edgeKey?: number;
  /** Stable undirected physical identity. Optional only for in-memory algorithm fixtures. */
  physicalEdgeKey?: number;
  fromNodeId: string;
  toNodeId: string;
  coordinates: Array<readonly [number, number]>;
  lengthMeters: number;
  gainMeters: number;
  lossMeters: number;
  maximumElevationMeters: number | null;
  maximumSustainedGradePct: number | null;
  /** Complete direction-aware profile on schema-5 packs; samples are <=25 m apart. */
  elevationProfile?: Array<{ distanceMeters: number; elevationMeters: number }>;
  accessState: AccessState;
  /** Semantic class. Required by the SQLite reader. */
  edgeClass?: EdgeClass;
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
  /** OSM buildings within BUILDING_RADIUS_M of the snapped node. */
  nearbyBuildingCount: number;
  reachableTrailKm?: number;
  trailComponentId?: string | null;
  portalRoadClass?: "street" | "service-road" | null;
  parkingDistanceM?: number | null;
};

export type InducedGraph = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  accessPoints: GraphAccessPoint[];
};
