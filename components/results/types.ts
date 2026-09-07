import type { SearchResult, SearchRoute, CloseSearchRoute, RouteJobV2 } from "@/lib/contracts/search";

export type ResultRoute = SearchRoute;
export type CloseResultRoute = CloseSearchRoute;
export type RouteResults = ({ kind: "quick" } & SearchResult) | {
  kind: "saved";
  job: RouteJobV2;
  exact: SearchRoute[];
  nearMisses: CloseSearchRoute[];
  nextCursor?: string;
};
