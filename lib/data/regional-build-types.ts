import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import type { AreaGeometry } from "./area-geometry";
import type { NormalizedTopology } from "./types";

export type RegionalPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
  onProgress?: (progress: RegionalPackBuildProgress) => void;
};

export type RegionalPackBuildProgress = { phase: number; phaseCount: number; label: string };

/** Source adapters finish validation before handing entrance evidence to the builder. */
export type PreparedRegionalEntrances = {
  snapshot: SourceSnapshot;
  adapterVersion: string;
  evidence: NormalizedAccessEvidence[];
};

/** Regional facts and the two real variations: entrance acquisition and acceptance. */
export type RegionalPackDefinition = {
  id: string;
  name: string;
  dataVersionPrefix: string;
  compilerVersion: string;
  regionRoot: string;
  boundaryVersion?: string;
  display: { center: [number, number]; zoom: number };
  /** Preserve the older joined fingerprint used by the installed Santa Cruz packs. */
  fingerprintFormat?: "joined-v1";
  restrictions?: { contentHash: `sha256:${string}` };
  entrances?: (options: RegionalPackBuildOptions) => Promise<PreparedRegionalEntrances>;
  officialTrails?: { sourceConfigPath: string; conflationPolicyPath: string };
  /** Throw on regional acceptance failure; measurements are retained in the portal audit. */
  checkPortals?: (topology: NormalizedTopology, boundary: AreaGeometry) => Record<string, unknown>;
};
