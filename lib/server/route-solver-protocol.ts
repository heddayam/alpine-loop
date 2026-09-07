import type { GenerateClosedRoutesResponseV3, RouteCriteria } from "@/lib/contracts";
import type { ResolvedAccessFilterContext, RouteSearchPolicy, SolverBudget } from "@/lib/solver";

export type StartSearchResult = Pick<GenerateClosedRoutesResponseV3, "exact" | "nearMisses"> & {
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
  | { id: number; ok: true; value?: readonly string[] | StartSearchResult | GenerateClosedRoutesResponseV3 }
  | { id: number; ok: false; error: { name: string; message: string; code?: string; status?: number; stack?: string } };
