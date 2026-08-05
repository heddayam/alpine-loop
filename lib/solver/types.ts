import type {
  GenerateRoutesRequestV1,
  GenerateRoutesRequestV2,
  GenerateRoutesResponseV1,
  GenerateRoutesResponseV2,
  GenerateClosedRoutesRequestV3,
  GenerateClosedRoutesResponseV3,
} from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import type { ClosedRouteTopologyRepository, GraphRepository } from "@/lib/graph/types";
import type { SolverBudget } from "./budget";
import type { ClosedRoutePrimitiveCatalog } from "./closed-route-types";

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

export type ClosedRouteGenerationV3Context = RouteGenerationContext & {
  accessFilter: ResolvedAccessFilterContext;
  topologyRepository: ClosedRouteTopologyRepository;
  primitiveCatalog: ClosedRoutePrimitiveCatalog;
};

export interface ClosedRouteSolverV3 {
  generate(
    request: GenerateClosedRoutesRequestV3,
    context: ClosedRouteGenerationV3Context,
  ): Promise<GenerateClosedRoutesResponseV3>;
}
