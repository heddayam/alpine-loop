import type { AccessState } from "@/lib/graph/types";

export type Coordinate = readonly [lon: number, lat: number];

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
  sourceRefs: string[];
  flags: string[];
};

export type NormalizedTopology = {
  nodes: NormalizedNode[];
  ways: NormalizedWay[];
  accessPoints: NormalizedAccessPoint[];
  rejectedWayCount: number;
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
};

export type CompiledEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  geometry: Coordinate[];
  lengthM: number;
  gainM: number | null;
  lossM: number | null;
  maxElevationM: number | null;
  maxSustainedGradePct: number | null;
  accessState: AccessState;
  sourceRefs: string[];
  flags: string[];
};

export type PackAudit = {
  schemaVersion: "1";
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
};

export type PackBuildResult = {
  packDirectory: string;
  databasePath: string;
  manifestPath: string;
  auditPath: string;
  audit: PackAudit;
  reusedExisting: boolean;
};
