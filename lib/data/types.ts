import type { AccessState } from "@/lib/graph/types";
import type { NamedArea, TopologyProfile } from "@/lib/contracts";

export type Coordinate = readonly [lon: number, lat: number];

export type EdgeClass = "trail" | "service-road" | "street" | "sidewalk";

export type NormalizedNode = {
  id: string;
  externalId: string;
  lon: number;
  lat: number;
  elevationM: number | null;
  flags: string[];
  sourceRefs: string[];
};

export type NormalizedWay = {
  id: string;
  externalId: string;
  nodeIds: string[];
  coordinates: Coordinate[];
  name: string | null;
  accessState: AccessState;
  bidirectional: boolean;
  /** Required from the schema-6 OSM adapter; absent on legacy fixtures. */
  edgeClass?: EdgeClass;
  sourceRefs: string[];
  flags: string[];
};

export type NormalizedTopology = {
  nodes: NormalizedNode[];
  ways: NormalizedWay[];
  accessPoints: NormalizedAccessPoint[];
  portalEvidence?: NormalizedPortalEvidence[];
  rejectedWayCount: number;
};

export type NormalizedPortalEvidence = {
  id: string;
  externalId: string;
  kind: "parking" | "trailhead" | "information" | "gate";
  name: string | null;
  nodeIds: string[];
  coordinates: Coordinate[];
  accessState: AccessState;
  sourceRefs: string[];
};

export type NormalizedAccessPoint = {
  id: string;
  externalId: string;
  nodeId: string;
  name: string;
  kind: "trailhead" | "parking";
  accessState: AccessState;
  confidence: "high" | "medium" | "low";
  parkingEvidence: string | null;
  sourceRefs: string[];
  knownConnectivity?: number;
  inclusiveConnectivity?: number;
  knownOutDegree?: number;
  inclusiveOutDegree?: number;
  reachableTrailKm?: number;
  trailComponentId?: string | null;
  portalRoadClass?: "street" | "service-road" | null;
  parkingDistanceM?: number | null;
  /** OSM buildings within BUILDING_RADIUS_M of the snapped node. */
  nearbyBuildingCount?: number;
};

export type NormalizedNamedArea = NamedArea & {
  aliases: string[];
};

export type NormalizedSearchRegion = {
  namedAreaId: string;
  displayOrder: number;
};

export type CompiledEdge = {
  id: string;
  stablePhysicalId: string;
  fromNode: string;
  toNode: string;
  geometry: Coordinate[];
  lengthM: number;
  gainM: number | null;
  lossM: number | null;
  maxElevationM: number | null;
  maxSustainedGradePct: number | null;
  elevationProfile?: Array<{ distanceMeters: number; elevationMeters: number }> | null;
  accessState: AccessState;
  edgeClass?: EdgeClass;
  sourceRefs: string[];
  flags: string[];
};

/** Schema-6 compact wire shape: primitive tables are intentionally empty. */
export type TopologyProfileBuild = {
  profile: TopologyProfile;
  formatVersion: number;
  nodeCount: 0;
  physicalEdgeCount: number;
  decisionNodeCount: 0;
  decisionEdgeCount: 0;
  builtAt: string;
  contentHash: string;
  nodes: [];
  decisionEdges: [];
  blocks: [];
  blockLinks: [];
  networks: [];
  accessTopology: Array<{
    accessPointId: string;
    attachmentDecisionNodeId: number;
    cycleNetworkId: number | null;
    connectorKey: string | null;
    connectorDecisionEdgeIds: [];
    portalDecisionNodeId: number | null;
    minimumStemDistanceM: number | null;
    canReachCycle: boolean;
  }>;
};

export type ClosedRouteTopologyBuild = {
  runtimeMode: "reachable-graph-fallback";
  algorithmVersion: string;
  policyVersion: string;
  contentHash: string;
  nodeKeys: Map<string, number>;
  edgeKeys: Map<string, number>;
  physicalEdges: Array<{
    physicalEdgeKey: number;
    stablePhysicalId: string;
    fromNodeKey: number;
    toNodeKey: number;
    geometryHash: string;
  }>;
  physicalEdgeKeysByStableId: Map<string, number>;
  profiles: TopologyProfileBuild[];
};

export type PackAudit = {
  schemaVersion: "6";
  packId: string;
  dataVersion: string;
  nodeCount: number;
  directedEdgeCount: number;
  accessPointCount: number;
  sourceCount: number;
  rejectedWayCount: number;
  conflictCount: number;
  missingElevationNodeCount: number;
  missingElevationEdgeCount: number;
  accessStateCounts: Record<AccessState, number>;
  namedAreaCount?: number;
  searchRegionCount?: number;
  rejectedCoverageEdgeCount?: number;
  builtUpAccessPointCount?: number;
  topologyContentHash?: string;
  topologyProfiles?: Array<{
    profile: TopologyProfile;
    contentHash: string;
    nodeCount: number;
    physicalEdgeCount: number;
    decisionNodeCount: number;
    decisionEdgeCount: number;
    blockCount: number;
    cycleBlockCount: number;
    networkCount: number;
    feasibleAccessPointCount: number;
    noCycleAccessPointCount: number;
  }>;
};

export type PackBuildResult = {
  packDirectory: string;
  databasePath: string;
  manifestPath: string;
  auditPath: string;
  audit: PackAudit;
  reusedExisting: boolean;
};
