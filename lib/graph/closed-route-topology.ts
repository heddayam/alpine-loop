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

export type ReconstructedDirectedEdge = GraphEdge & {
  edgeKey: number;
  physicalEdgeKey: number;
  stablePhysicalEdgeId: string;
  minimumElevationMeters: number | null;
};
