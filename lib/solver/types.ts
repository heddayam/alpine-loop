import type { GenerateClosedRoutesResponseV3, RouteCriteria, SearchEffortV3 } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";

export type ResolvedAccessFilterContext = {
  summary: GenerateClosedRoutesResponseV3["resolvedAccessFilter"];
  predicates: readonly AreaGeometry[];
  namedRegionPredicateIndex?: number;
  coverage: AreaGeometry;
};

export type RouteSearchPolicy = {
  searchEffort: SearchEffortV3;
  limit: number;
  startAccessPointId?: string;
};

export type RouteSearchRequest = RouteCriteria & RouteSearchPolicy;
