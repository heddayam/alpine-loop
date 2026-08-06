import type { AccessPointSearchResult, RouteJobRunnerDependencies } from "@/lib/route-jobs";

export type RouteJobSolverWorkerInput = Omit<
  Parameters<RouteJobRunnerDependencies["openSearchSession"]>[0],
  "signal"
>;

export type RouteJobSolverRequest =
  | { id: number; type: "initialize"; input: RouteJobSolverWorkerInput }
  | { id: number; type: "enumerate" }
  | { id: number; type: "search"; accessPointId: string }
  | { id: number; type: "close" };

export type RouteJobSolverResponse =
  | { id: number; ok: true; value?: readonly string[] | AccessPointSearchResult }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } };
