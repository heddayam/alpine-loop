import type { AccessFilterV2 } from "@/lib/contracts";
import type { AccessPointSearchResult, RouteJobRunnerDependencies } from "@/lib/route-jobs";

export type RouteJobSolverWorkerInput = Omit<
  Parameters<RouteJobRunnerDependencies["openSearchSession"]>[0],
  "signal"
>;

export function routeJobSolverRequestAccessFilter(
  input: RouteJobSolverWorkerInput,
  reviewedRegionId?: string,
): AccessFilterV2 {
  if (input.request.drawnAreaBbox) {
    return { mode: "drawn-area", bbox: input.request.drawnAreaBbox };
  }
  if (input.driveTimeGeometry && reviewedRegionId) {
    return {
      mode: "drive-time",
      reachabilityId: "00000000-0000-4000-8000-000000000000",
      regionId: reviewedRegionId,
    };
  }
  if (reviewedRegionId) return { mode: "named-region", regionId: reviewedRegionId };
  throw new Error("The job's access filter is unavailable.");
}

export type RouteJobSolverRequest =
  | { id: number; type: "initialize"; input: RouteJobSolverWorkerInput }
  | { id: number; type: "enumerate" }
  | { id: number; type: "search"; accessPointId: string }
  | { id: number; type: "close" };

export type RouteJobSolverResponse =
  | { id: number; ok: true; value?: readonly string[] | AccessPointSearchResult }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } };
