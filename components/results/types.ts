import type {
  ConstraintViolationV3,
  GeneratedClosedRouteV3,
  GenerateClosedRoutesResponseV3,
  RouteJob,
} from "@/lib/contracts";

export type ResultRoute = GeneratedClosedRouteV3 & { regionLabel: string };
export type CloseResultRoute = ResultRoute & { violations: ConstraintViolationV3[] };

export type QuickSearchDetails = Pick<
  GenerateClosedRoutesResponseV3,
  "requestId" | "pack" | "resolvedAccessFilter" | "diagnostics"
> & { label: string };

/** Routes being viewed, with the real search or saved job that produced them. */
export type RouteResults = {
  exact: ResultRoute[];
  nearMisses: CloseResultRoute[];
} & (
  | { kind: "quick"; requested: number; searches: QuickSearchDetails[] }
  | { kind: "saved"; job: RouteJob; nextCursor?: string }
);
