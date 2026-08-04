import type { AccessState } from "@/lib/graph/types";

export type AuditSource = {
  id: string;
  authority: string;
  dataset: string;
  version: string;
  retrievedAt: string;
  url: string;
  license: string;
  termsDecision: string;
  contentHash: string;
};
export type AuditNode = { id: string; elevationM: number | null; sourceRefs: string[] };
export type AuditEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  lengthM: number;
  gainM: number | null;
  lossM: number | null;
  maxElevationM: number | null;
  maxSustainedGradePct: number | null;
  accessState: AccessState;
  sourceRefs: string[];
  flags?: string[];
};
export type AuditAccessPoint = { id: string; accessState: AccessState; sourceRefs: string[] };

export type RegionalPackAuditInput = {
  packId: string;
  dataVersion: string;
  nodes: AuditNode[];
  edges: AuditEdge[];
  accessPoints: AuditAccessPoint[];
  sources: AuditSource[];
  rejectedEdgeCount: number;
  conflictRecordIds?: string[];
};

export type RegionalPackAudit = {
  schemaVersion: "1";
  packId: string;
  dataVersion: string;
  counts: {
    nodes: number;
    directedEdges: number;
    accessPoints: number;
    sources: number;
    rejectedEdges: number;
    conflicts: number;
  };
  accessStateCounts: Record<AccessState, number>;
  topology: {
    componentCount: number;
    isolatedNodeCount: number;
    largestComponentNodeCount: number;
    largestComponentFraction: number;
  };
  elevation: { missingNodeCount: number; missingEdgeCount: number };
  implausibleMetricRecordIds: string[];
  unattributedRecordIds: string[];
  unknownSourceReferenceRecordIds: string[];
  errors: string[];
  warnings: string[];
};
