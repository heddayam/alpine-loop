import type { AccessState } from "@/lib/graph/types";

export type SourceSnapshot = {
  id: string;
  authority: string;
  dataset: string;
  version: string;
  retrievedAt: string;
  url: string;
  license: string;
  contentHash: `sha256:${string}`;
  localPath: string;
};

export type NormalizedAccessEvidence = {
  sourceId: string;
  externalId: string;
  lon: number;
  lat: number;
  name: string;
  accessState: AccessState;
  confidence: "high" | "medium" | "low";
};

export interface TopologySourceAdapter<T = unknown> {
  readonly adapterVersion: string;
  validate(snapshot: SourceSnapshot): Promise<void>;
  normalize(snapshot: SourceSnapshot): AsyncIterable<T>;
}

export interface OfficialAccessAdapter {
  readonly adapterVersion: string;
  validate(snapshot: SourceSnapshot): Promise<void>;
  normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]>;
}

export interface ElevationSampler {
  readonly algorithmVersion: string;
  sample(coordinates: ReadonlyArray<readonly [number, number]>): Promise<Array<number | null>>;
}
