import type {
  CreateBatchRouteJobV1,
  GeneratedClosedRouteV3,
  ConstraintViolationV3,
} from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";

export type PinnedRouteJobPack = {
  id: string;
  dataVersion: string;
  builtAt: string;
};

export type ResolvedRouteJob = {
  pack: PinnedRouteJobPack;
  searchRegion: { id: string; name: string };
};

export type ResolvedDriveTime = {
  geometry: AreaGeometry;
  resolvedAt: string;
};

export type DriveTimeBatchRouteJobRequest = CreateBatchRouteJobV1 & {
  origin: NonNullable<CreateBatchRouteJobV1["origin"]>;
  durationMinutes: NonNullable<CreateBatchRouteJobV1["durationMinutes"]>;
};

export type BatchNearMiss = GeneratedClosedRouteV3 & {
  violations: ConstraintViolationV3[];
};

export type AccessPointSearchResult = {
  exact: GeneratedClosedRouteV3[];
  nearMisses: BatchNearMiss[];
  truncated: boolean;
  diagnostics?: unknown;
};

export type RouteJobSearchSession = {
  enumerateEligibleAccessPointIds(signal: AbortSignal): Promise<readonly string[]>;
  searchAccessPoint(accessPointId: string, signal: AbortSignal): Promise<AccessPointSearchResult>;
  close(): Promise<void>;
};

export type RouteJobRunnerDependencies = {
  resolveJob(request: CreateBatchRouteJobV1, signal: AbortSignal): Promise<ResolvedRouteJob>;
  resolveDriveTime(request: DriveTimeBatchRouteJobRequest, signal: AbortSignal): Promise<ResolvedDriveTime>;
  currentDataVersion(packId: string): Promise<string | null>;
  openSearchSession(input: {
    request: CreateBatchRouteJobV1;
    pack: PinnedRouteJobPack;
    searchRegionId: string;
    driveTimeGeometry?: AreaGeometry;
    signal: AbortSignal;
  }): Promise<RouteJobSearchSession>;
};
