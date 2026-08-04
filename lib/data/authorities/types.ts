import type { AccessState } from "@/lib/graph/types";
import type { NormalizedAccessEvidence } from "../adapters";

export type OfficialSourceDecision = {
  id: string;
  authority: string;
  dataset: string;
  version: string;
  retrievedAt: string;
  itemUrl: string;
  downloadUrl: string;
  license: string;
  termsDecision: string;
  redistribution: "allowed" | "blocked" | "requires-review";
  metadataContentHash: `sha256:${string}`;
};

export type OfficialAccessResolution = {
  state: AccessState;
  conflict: boolean;
  winningTier: "official-restriction" | "official-permission" | "osm" | "unknown";
};

export type OfficialAccessJoinFeature = {
  sourceId: string;
  authorityFeatureId: string;
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
  evidence: NormalizedAccessEvidence;
};

export type OfficialAccessJoin = {
  sourceId: string;
  authorityFeatureId: string;
  targetExternalId: string;
  matchMethod: "spatial-intersection" | "nearest-within-tolerance";
  distanceM: number;
  evidence: NormalizedAccessEvidence;
};
