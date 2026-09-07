import type { TopologyProfile } from "@/lib/contracts";
import type { GraphEdge } from "./types-internal";

export const CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION = 2;
export const CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION = "original-graph-feasibility-v2";

export type AccessTopology = {
  profile: TopologyProfile;
  accessPointId: string;
  /** Format 1 uses historical decision IDs; format 2 uses original graph node keys. */
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
  minimumElevationMeters: number | null;
  fromElevationMeters?: number | null;
  toElevationMeters?: number | null;
};
