import type { GenerateRoutesRequestV1, GenerateRoutesResponseV1 } from "@/lib/contracts";
import type { GraphRepository } from "@/lib/graph/types";
import type { SolverBudget } from "./budget";

export type RouteGenerationContext = {
  repository: GraphRepository;
  budget: SolverBudget;
  signal?: AbortSignal;
  now?: () => number;
};

export interface RouteSolver {
  generate(request: GenerateRoutesRequestV1, context: RouteGenerationContext): Promise<GenerateRoutesResponseV1>;
}
