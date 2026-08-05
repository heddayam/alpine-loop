import type { TopologyProfile } from "@/lib/contracts";
import type { GraphEdge } from "./types-internal";

export type AccessTopology = {
  profile: TopologyProfile;
  accessPointId: string;
  attachmentDecisionNodeId: number;
  cycleNetworkId: number | null;
  connectorKey: string | null;
  connectorDecisionEdgeIds: readonly number[];
  portalDecisionNodeId: number | null;
  minimumStemDistanceMeters: number | null;
  canReachCycle: boolean;
};

export type CycleNetworkSummary = {
  profile: TopologyProfile;
  networkId: number;
  decisionNodeCount: number;
  decisionEdgeCount: number;
  cycleBlockCount: number;
  minimumCycleLengthMeters: number | null;
  maximumCycleLengthMeters: number | null;
  minimumElevationMeters: number | null;
  maximumElevationMeters: number | null;
};

export type TopologyDecisionNode = {
  id: number;
  sourceNodeId: string;
  connectedComponentId: number;
  twoEdgeComponentId: number;
  isArticulation: boolean;
  vertexBlockIds: readonly number[];
};

export type TopologyDecisionEdgeMember = {
  sequenceIndex: number;
  edgeKey: number;
  physicalEdgeKey: number;
};

export type TopologyDecisionEdge = {
  id: number;
  fromDecisionNodeId: number;
  toDecisionNodeId: number;
  lengthMeters: number;
  gainMeters: number;
  lossMeters: number;
  maximumElevationMeters: number | null;
  maximumSustainedGradePct: number | null;
  accessState: "public" | "unknown";
  trailNames: readonly string[];
  sourceIds: readonly string[];
  flags: readonly string[];
  isBridge: boolean;
  twoEdgeComponentId: number;
  vertexBlockId: number | null;
  members: readonly TopologyDecisionEdgeMember[];
};

export type TopologyBlock = {
  id: number;
  kind: "vertex-cycle" | "bridge";
  decisionNodeIds: readonly number[];
  decisionEdgeIds: readonly number[];
  cycleRank: number;
  totalPhysicalLengthMeters: number;
  minimumCycleLengthMeters: number | null;
  minimumElevationMeters: number | null;
  maximumElevationMeters: number | null;
  trailNames: readonly string[];
};

export type TopologyBlockLink = {
  fromBlockId: number;
  toBlockId: number;
  articulationDecisionNodeId: number;
  connectorDistanceMeters: number;
};

export type DecisionNetwork = {
  profile: TopologyProfile;
  networkId: number;
  nodes: ReadonlyMap<number, TopologyDecisionNode>;
  edges: readonly TopologyDecisionEdge[];
  blocks: readonly TopologyBlock[];
  blockLinks: readonly TopologyBlockLink[];
  estimatedByteSize: number;
  contentHash: string;
};

export type ReconstructedDirectedEdge = GraphEdge & {
  edgeKey: number;
  physicalEdgeKey: number;
  stablePhysicalEdgeId: string;
};

export type TopologyCacheDiagnostics = {
  hits: number;
  misses: number;
  concurrentLoadJoins: number;
  loads: number;
  loadedBytes: number;
  residentBytes: number;
  evictions: number;
};

export interface ClosedRouteTopologyRepository {
  readonly packId: string;
  readonly dataVersion: string;

  getAccessTopology(
    profile: TopologyProfile,
    accessPointIds: readonly string[],
  ): Promise<AccessTopology[]>;
  getNetworkSummary(profile: TopologyProfile, networkId: number): Promise<CycleNetworkSummary>;
  loadDecisionNetwork(profile: TopologyProfile, networkId: number): Promise<DecisionNetwork>;
  reconstructDirectedEdges(compressedEdgeIds: readonly number[]): Promise<ReconstructedDirectedEdge[]>;
  getCacheDiagnostics(): TopologyCacheDiagnostics;
  invalidate(): void;
  close(): Promise<void>;
}
