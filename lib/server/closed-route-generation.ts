import {
  generateClosedRoutesRequestV3Schema,
  generateClosedRoutesResponseV3Schema,
  type GenerateClosedRoutesRequestV3,
  type GenerateClosedRoutesResponseV3,
  type SearchEffortV3,
} from "@/lib/contracts";
import {
  lineIsInsideArea,
  type ClosedRouteFeasibilityRepository,
} from "@/lib/graph";
import {
  AccessFilterResolutionError,
  CLOSED_ROUTE_EFFORT_BUDGETS,
  type ResolvedAccessFilterContext,
  type RouteSearchRequest,
  type SolverBudget,
} from "@/lib/solver";
import { apiErrorResponse, isCancellationError, ServerApiError } from "./api-error";
import { resolveAccessFilter, type ReachabilityResolver } from "./access-filter";
import type { RoutePack } from "./route-pack";

export type ClosedRoutePack = RoutePack & {
  closedRouteRuntimeMode?: "primitive" | "reachable-graph-fallback";
  loadClosedRouteFeasibilityRepository?: (
    signal: AbortSignal,
  ) => Promise<ClosedRouteFeasibilityRepository>;
};

export type ReachableGraphFallbackPack = ClosedRoutePack & {
  schemaVersion: "3" | "4" | "5" | "6";
  closedRouteRuntimeMode: "reachable-graph-fallback";
  loadClosedRouteFeasibilityRepository: (
    signal: AbortSignal,
  ) => Promise<ClosedRouteFeasibilityRepository>;
};

export type RouteExecutionContext = {
  accessFilter: ResolvedAccessFilterContext;
  budget: SolverBudget;
  signal: AbortSignal;
};

export type ClosedRouteGenerationDependencies = {
  packs: ReadonlyMap<string, ClosedRoutePack>;
  generate: (
    pack: ReachableGraphFallbackPack,
    request: RouteSearchRequest,
    context: RouteExecutionContext,
  ) => Promise<GenerateClosedRoutesResponseV3>;
  resolveReachability: ReachabilityResolver;
  budgets?: Readonly<Record<SearchEffortV3, Readonly<SolverBudget>>>;
};

function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return apiErrorResponse(new ServerApiError(code, message, status, details));
}

function validationDetails(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, unknown> {
  return { issues: issues.map(({ path, message }) => ({ path: path.map(String).join("."), message })) };
}

function isFallbackPack(pack: ClosedRoutePack): pack is ReachableGraphFallbackPack {
  return (pack.schemaVersion === "3" || pack.schemaVersion === "4" || pack.schemaVersion === "5" || pack.schemaVersion === "6")
    && pack.closedRouteRuntimeMode === "reachable-graph-fallback"
    && typeof pack.loadClosedRouteFeasibilityRepository === "function";
}

function sameCoordinates(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  return left?.length === 2 && right?.length === 2 && left[0] === right[0] && left[1] === right[1];
}

function responseSemanticIssue(
  response: GenerateClosedRoutesResponseV3,
  request: GenerateClosedRoutesRequestV3,
  pack: ReachableGraphFallbackPack,
  resolvedFilter: Awaited<ReturnType<typeof resolveAccessFilter>>,
): string | undefined {
  if (response.requested !== request.limit) return "The response requested count does not match the request";
  if (response.pack.id !== pack.id
    || response.pack.schemaVersion !== pack.schemaVersion
    || response.pack.dataVersion !== pack.dataVersion
    || response.pack.builtAt !== pack.builtAt) {
    return "The response pack metadata does not match the loaded pack";
  }
  if (JSON.stringify(response.resolvedAccessFilter) !== JSON.stringify(resolvedFilter.summary)) {
    return "The response access-filter summary does not match the resolved filter";
  }
  if (response.exact.length > request.limit) return "The response contains more exact routes than requested";
  const routes = [...response.exact, ...response.nearMisses];
  if (routes.some((route) => !lineIsInsideArea(route.geometry.coordinates, pack.coverage))) {
    return "A response route leaves exact installed-pack coverage";
  }
  if (routes.some((route) => !sameCoordinates(route.geometry.coordinates[0], route.geometry.coordinates.at(-1)))) {
    return "A response route is not geometrically closed";
  }
  const diagnostics = response.diagnostics;
  if (JSON.stringify(diagnostics.truncationReasons) !== JSON.stringify(diagnostics.hardTruncationReasons)) {
    return "Hard truncation diagnostics disagree with the compatibility diagnostics";
  }
  if (JSON.stringify(diagnostics.shortfallReasons) !== JSON.stringify(diagnostics.nonBudgetShortfallReasons)) {
    return "Non-budget shortfall diagnostics disagree with the compatibility diagnostics";
  }
  if (response.exact.length < request.limit
    && diagnostics.hardTruncationReasons.length === 0
    && diagnostics.nonBudgetShortfallReasons.length === 0) {
    return "A response with fewer routes than requested must explain why in diagnostics";
  }
  return undefined;
}

function deadlineSignal(requestSignal: AbortSignal, deadlineMs: number) {
  const controller = new AbortController();
  let expired = false;
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException("Route generation exceeded its deadline", "TimeoutError"));
  }, deadlineMs);
  return {
    signal: controller.signal,
    didExpire: () => expired,
    dispose: () => {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  };
}

function explicitStartError(error: AccessFilterResolutionError): Response {
  const mapping = {
    START_NOT_FOUND: [404, "START_NOT_FOUND", "The selected access point was not found."],
    START_OUTSIDE_FILTER: [422, "START_OUTSIDE_FILTER", "The selected access point is outside the trailhead filter."],
    START_INELIGIBLE: [422, "START_INELIGIBLE", "The selected access point is excluded by the access policy."],
  } as const;
  const [status, code, message] = mapping[error.code];
  return errorResponse(status, code, message);
}

export function createGenerateClosedRoutesHandler(dependencies: ClosedRouteGenerationDependencies) {
  const budgets = dependencies.budgets ?? CLOSED_ROUTE_EFFORT_BUDGETS;
  return async function POST(request: Request): Promise<Response> {
    if (request.signal.aborted) {
      return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      if (request.signal.aborted || isCancellationError(error)) {
        return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
      }
      return errorResponse(400, "MALFORMED_JSON", "Request body must be valid JSON");
    }
    const version = typeof body === "object" && body !== null ? (body as { version?: unknown }).version : undefined;
    if (version === 1 || version === 2) {
      return errorResponse(400, "UNSUPPORTED_REQUEST_VERSION", `Route generation request version ${version} is no longer supported.`);
    }
    const parsedRequest = generateClosedRoutesRequestV3Schema.safeParse(body);
    if (!parsedRequest.success) {
      return errorResponse(400, "INVALID_REQUEST", "Request body does not match the V3 closed-route contract",
        validationDetails(parsedRequest.error.issues));
    }
    const routeRequest = parsedRequest.data;
    const pack = dependencies.packs.get(routeRequest.packId);
    if (!pack) {
      return errorResponse(404, "PACK_NOT_FOUND", `Pack '${routeRequest.packId}' is not installed`, {
        supportedPackIds: [...dependencies.packs.keys()].sort(),
      });
    }
    if (!isFallbackPack(pack)) {
      return errorResponse(422, "CLOSED_ROUTES_UNAVAILABLE",
        `Pack '${pack.id}' does not provide the schema-3 reachable-graph closed-route runtime; rebuild or reinstall it`);
    }

    const budget = { ...budgets[routeRequest.searchEffort] };
    const deadline = deadlineSignal(request.signal, budget.deadlineMs);
    try {
      const resolvedFilter = await resolveAccessFilter(
        pack,
        routeRequest.accessFilter,
        dependencies.resolveReachability,
        deadline.signal,
      );
      const solverResponse = await dependencies.generate(pack, routeRequest, {
        budget,
        signal: deadline.signal,
        accessFilter: resolvedFilter,
      });
      const parsedResponse = generateClosedRoutesResponseV3Schema.safeParse(solverResponse);
      if (!parsedResponse.success) {
        return errorResponse(500, "INVALID_SOLVER_RESPONSE", "The closed-route solver returned an invalid response",
          validationDetails(parsedResponse.error.issues));
      }
      const semanticIssue = responseSemanticIssue(parsedResponse.data, routeRequest, pack, resolvedFilter);
      return semanticIssue
        ? errorResponse(500, "INVALID_SOLVER_RESPONSE", semanticIssue)
        : Response.json(parsedResponse.data);
    } catch (error) {
      if (error instanceof ServerApiError) return apiErrorResponse(error);
      if (error instanceof AccessFilterResolutionError) return explicitStartError(error);
      if (deadline.didExpire()) {
        return errorResponse(504, "DEADLINE_EXCEEDED", "Route generation exceeded the server deadline");
      }
      if (request.signal.aborted || isCancellationError(error)) {
        return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
      }
      return errorResponse(500, "INTERNAL_ERROR", "Route generation failed unexpectedly");
    } finally {
      deadline.dispose();
    }
  };
}
