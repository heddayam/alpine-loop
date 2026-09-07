import type { SearchArea, SearchIntent, SearchRoute, CloseSearchRoute } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import type { SearchPlan } from "@/lib/server/search-plan";

export type { RouteJobV2 as RouteJob, RouteJobResultV2 as RouteJobResult, RouteJobResultsPageV2 as RouteJobResultsPage } from "@/lib/contracts";

export type ResolvedDriveTime = { geometry: AreaGeometry; resolvedAt: string };

export type AccessPointSearchResult = {
  exact: SearchRoute[];
  nearMisses: CloseSearchRoute[];
  truncated: boolean;
  diagnostics?: unknown;
};

export type RouteJobSearchSession = {
  enumerateEligibleAccessPointIds(signal: AbortSignal): Promise<readonly string[]>;
  searchAccessPoint(accessPointId: string, signal: AbortSignal): Promise<AccessPointSearchResult>;
  close(): Promise<void>;
};

export type RouteJobRunnerDependencies = {
  resolveJob(request: SearchIntent, signal: AbortSignal): Promise<SearchPlan>;
  resolveDriveTime(area: Extract<SearchArea, { mode: "drive-time" }>, signal: AbortSignal): Promise<ResolvedDriveTime>;
  currentDataVersion(packId: string): Promise<string | null>;
  openSearchSession(input: { request: SearchIntent; plan: SearchPlan; signal: AbortSignal }): Promise<RouteJobSearchSession>;
};
