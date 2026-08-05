import type {
  GenerateRoutesRequestV1,
  GenerateRoutesRequestV2,
  GenerateRoutesResponseV1,
  GenerateRoutesResponseV2,
} from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
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

export type ResolvedAccessFilterContext = {
  summary: GenerateRoutesResponseV2["resolvedAccessFilter"];
  predicates: readonly AreaGeometry[];
  coverage: AreaGeometry;
};

export type RouteGenerationV2Context = RouteGenerationContext & {
  accessFilter: ResolvedAccessFilterContext;
};

export interface RouteSolverV2 {
  generate(request: GenerateRoutesRequestV2, context: RouteGenerationV2Context): Promise<GenerateRoutesResponseV2>;
}
