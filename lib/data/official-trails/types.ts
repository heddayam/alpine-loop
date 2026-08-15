import type { AccessState } from "@/lib/graph/types";
import type { Coordinate, NormalizedTopology } from "../types";

export type OfficialTrailFeature = {
  externalId: string;
  name: string | null;
  trailNumber: string | null;
  coordinates: Coordinate[];
  accessState: AccessState;
  sourceRefs: string[];
  flags: string[];
  eligible: boolean;
  eligibilityReason: string | null;
};

export type OfficialTrailConflationPolicy = {
  sampleStepM: number;
  representedDistanceM: number;
  internalConnectionDistanceM: number;
  maximumConnectionAngleDegrees: number;
  endpointConnectionDistanceM: number;
  candidateConnectionDistanceM: number;
  maximumTransitionLengthM: number;
  duplicateDistanceM: number;
  duplicateCoverageRatio: number;
  minimumGapLengthM: number;
};

export type OfficialTrailConflationAudit = {
  schemaVersion: "1";
  algorithmVersion: string;
  sourceId: string;
  policy: OfficialTrailConflationPolicy;
  inputFeatureCount: number;
  eligibleFeatureCount: number;
  ineligibleFeatureCount: number;
  representedFeatureCount: number;
  candidateGapCount: number;
  acceptedGapCount: number;
  rejectedGapCount: number;
  acceptedFeatureCount: number;
  addedLengthM: number;
  baseAttachmentCount: number;
  candidateAttachmentCount: number;
  truncatedEndpointCount: number;
  publishedPhysicalEdgeCount?: number;
  publishedLengthM?: number;
  rejectionCounts: Record<string, number>;
  accepted: Array<{
    id: string;
    externalId: string;
    name: string | null;
    lengthM: number;
    startAttachment: "base" | "official" | "terminal" | "truncated";
    endAttachment: "base" | "official" | "terminal" | "truncated";
  }>;
  rejected: Array<{
    externalId: string;
    name: string | null;
    reason: string;
    lengthM: number;
  }>;
};

export type OfficialTrailConflationResult = {
  topology: NormalizedTopology;
  audit: OfficialTrailConflationAudit;
};
