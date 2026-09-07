import type { RouteSearchResult } from "@/lib/solver/types";
import type { RouteCriteria } from "@/lib/contracts";
import type { ResolvedAccessFilterContext, RouteSearchPolicy, SolverBudget } from "@/lib/solver";

export type StartSearchResult = Pick<RouteSearchResult, "exact" | "nearMisses"> & {
  truncated: boolean;
  diagnostics?: unknown;
};

export type RouteSolverWorkerInput = {
  pack: { id: string; dataVersion: string };
  criteria: RouteCriteria;
  accessFilter: ResolvedAccessFilterContext;
};

export type RouteSolverRequest =
  | { id: number; type: "initialize"; input: RouteSolverWorkerInput }
  | { id: number; type: "enumerate" }
  | { id: number; type: "search"; accessPointId: string }
  | { id: number; type: "generate"; policy: RouteSearchPolicy; budget: SolverBudget }
  | { id: number; type: "close" };

export type RouteSolverResponse =
  | { id: number; ok: true; value?: readonly string[] | StartSearchResult | RouteSearchResult }
  | { id: number; ok: false; error: { name: string; message: string; code?: string; status?: number; stack?: string } };
