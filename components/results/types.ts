import type { SearchRoute, CloseSearchRoute, RouteJobV2 } from "@/lib/contracts/search";

export type ResultRoute = SearchRoute;
export type CloseResultRoute = CloseSearchRoute;
export type RouteResults = {
  job: RouteJobV2;
  exact: SearchRoute[];
  nearMisses: CloseSearchRoute[];
  nextCursor?: string;
};
