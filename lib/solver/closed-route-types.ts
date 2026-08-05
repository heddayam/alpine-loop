import type { TopologyProfile } from "@/lib/contracts";
import type { DecisionNetwork, TopologyBlock } from "@/lib/graph";

export type EdgeSignature = readonly number[];

export type ClosedRoutePrimitive = {
  id: number;
  policyVersion: string;
  profile: TopologyProfile;
  networkId: number;
  blockId: number;
  entryDecisionNodeId: number;
  exitDecisionNodeId: number;
  compressedEdgeIds: readonly number[];
  physicalEdgeSignature: EdgeSignature;
  distanceMeters: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  maximumElevationMeters: number | null;
  maximumSustainedGradePct: number | null;
  repeatedDistanceMeters: number;
  cycleCount: number;
  trailNames: readonly string[];
};

export type AssemblyLabel = {
  networkId: number;
  startAccessPointId: string;
  currentBlockId: number;
  primitiveIds: readonly number[];
  connectorIds: readonly number[];
  distanceMeters: number;
  elevationGainMeters: number;
  repeatedDistanceMeters: number;
  cycleCount: number;
  physicalEdgeSignature: EdgeSignature;
  lowerBoundScore: number;
};

export type ClosedRoutePrimitivePolicy = {
  version: string;
  maximumPrimitivesPerBlock: number;
  distanceBucketMeters: number;
  elevationBucketMeters: number;
  maximumStableSpanningTreeOrders: number;
};

export const DEFAULT_CLOSED_ROUTE_PRIMITIVE_POLICY: Readonly<ClosedRoutePrimitivePolicy> = Object.freeze({
  version: "closed-primitives-v1",
  maximumPrimitivesPerBlock: 256,
  distanceBucketMeters: 250,
  elevationBucketMeters: 50,
  maximumStableSpanningTreeOrders: 4,
});

export type PrimitiveCatalogDiagnostics = {
  hits: number;
  misses: number;
  generationCount: number;
  generatedPrimitiveCount: number;
  discardedPrimitiveCount: number;
  residentBytes: number;
  evictions: number;
};

export interface ClosedRoutePrimitiveCatalog {
  getPrimitives(
    network: DecisionNetwork,
    block: TopologyBlock,
    signal?: AbortSignal,
  ): Promise<readonly ClosedRoutePrimitive[]>;
  getDiagnostics(): PrimitiveCatalogDiagnostics;
  invalidate(dataVersion?: string, policyVersion?: string): void;
}
