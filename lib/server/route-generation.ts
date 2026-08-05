import {
  generateRoutesRequestV2Schema,
  generateRoutesResponseV2Schema,
  type GenerateRoutesRequestV2,
  type GenerateRoutesResponseV2,
  type NamedArea,
  type NamedAreaSummary,
} from "@/lib/contracts";
import { lineIsInsideArea, type AreaGeometry, type GraphRepository } from "@/lib/graph";
import {
  AccessFilterResolutionError,
  DEFAULT_SOLVER_BUDGET,
  type RouteSolverV2,
  type SolverBudget,
} from "@/lib/solver";
import { apiErrorResponse, isCancellationError, ServerApiError } from "./api-error";
import { resolveAccessFilter, type ReachabilityResolver } from "./access-filter";

export type RoutePack = {
  id: string;
  schemaVersion: string;
  dataVersion: string;
  builtAt: string;
  coverageBbox: readonly [west: number, south: number, east: number, north: number];
  coverage: AreaGeometry;
  maximumAreaSquareKilometers: number;
  databasePath?: string;
  searchNamedAreas?: (text: string, limit?: number) => NamedAreaSummary[] | Promise<NamedAreaSummary[]>;
  getNamedArea?: (id: string) => NamedArea | null | Promise<NamedArea | null>;
  loadRepository: (signal: AbortSignal) => Promise<GraphRepository>;
};

export type RouteGenerationDependencies = {
  packs: ReadonlyMap<string, RoutePack>;
  solver: RouteSolverV2;
  resolveReachability: ReachabilityResolver;
  budget?: SolverBudget;
};

function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return apiErrorResponse(new ServerApiError(code, message, status, details));
}

function validationDetails(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, unknown> {
  return { issues: issues.map(({ path, message }) => ({ path: path.map(String).join("."), message })) };
}

function responseSemanticIssue(
  response: GenerateRoutesResponseV2,
  request: GenerateRoutesRequestV2,
  pack: RoutePack,
  resolvedFilter: Awaited<ReturnType<typeof resolveAccessFilter>>,
): string | undefined {
  if (response.requested !== request.limit) return "The response requested count does not match the request";
  if (
    response.pack.id !== pack.id
    || response.pack.schemaVersion !== pack.schemaVersion
    || response.pack.dataVersion !== pack.dataVersion
    || response.pack.builtAt !== pack.builtAt
  ) return "The response pack metadata does not match the loaded pack";
  if (JSON.stringify(response.resolvedAccessFilter) !== JSON.stringify(resolvedFilter.summary)) {
    return "The response access-filter summary does not match the resolved filter";
  }
  if (response.exact.length > request.limit) return "The response contains more exact routes than requested";
  const routes = [...response.exact, ...response.nearMisses];
  if (routes.some((route) => !lineIsInsideArea(route.geometry.coordinates, pack.coverage))) {
    return "A response route leaves exact installed-pack coverage";
  }
  if (response.exact.length < request.limit
    && !response.diagnostics.exhausted
    && response.diagnostics.truncationReasons.length === 0
    && response.diagnostics.shortfallReasons.length === 0) {
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

export function createGenerateRoutesHandler(dependencies: RouteGenerationDependencies) {
  const budget = dependencies.budget ?? DEFAULT_SOLVER_BUDGET;
  return async function POST(request: Request): Promise<Response> {
    if (request.signal.aborted) return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      if (request.signal.aborted || isCancellationError(error)) {
        return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
      }
      return errorResponse(400, "MALFORMED_JSON", "Request body must be valid JSON");
    }
    if (typeof body === "object" && body !== null && (body as { version?: unknown }).version === 1) {
      return errorResponse(400, "UNSUPPORTED_REQUEST_VERSION", "Route generation request version 1 is no longer supported.");
    }
    const parsedRequest = generateRoutesRequestV2Schema.safeParse(body);
    if (!parsedRequest.success) {
      return errorResponse(400, "INVALID_REQUEST", "Request body does not match the V2 route-generation contract",
        validationDetails(parsedRequest.error.issues));
    }
    const routeRequest = parsedRequest.data;
    const pack = dependencies.packs.get(routeRequest.packId);
    if (!pack) {
      return errorResponse(404, "PACK_NOT_FOUND", `Pack '${routeRequest.packId}' is not installed`, {
        supportedPackIds: [...dependencies.packs.keys()].sort(),
      });
    }

    const deadline = deadlineSignal(request.signal, budget.deadlineMs);
    let repository: GraphRepository | undefined;
    try {
      const resolvedFilter = await resolveAccessFilter(
        pack,
        routeRequest.accessFilter,
        dependencies.resolveReachability,
        deadline.signal,
      );
      try {
        repository = await pack.loadRepository(deadline.signal);
      } catch (error) {
        if (deadline.didExpire()) return errorResponse(504, "DEADLINE_EXCEEDED", "Opening the local pack exceeded the server deadline");
        if (request.signal.aborted || isCancellationError(error)) {
          return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
        }
        return errorResponse(503, "PACK_UNAVAILABLE", `Pack '${pack.id}' could not be opened; rebuild or reinstall it`);
      }
      const solverResponse = await dependencies.solver.generate(routeRequest, {
        repository,
        budget,
        signal: deadline.signal,
        accessFilter: resolvedFilter,
      });
      const parsedResponse = generateRoutesResponseV2Schema.safeParse(solverResponse);
      if (!parsedResponse.success) {
        return errorResponse(500, "INVALID_SOLVER_RESPONSE", "The route solver returned an invalid response",
          validationDetails(parsedResponse.error.issues));
      }
      const semanticIssue = responseSemanticIssue(parsedResponse.data, routeRequest, pack, resolvedFilter);
      return semanticIssue
        ? errorResponse(500, "INVALID_SOLVER_RESPONSE", semanticIssue)
        : Response.json(parsedResponse.data);
    } catch (error) {
      if (error instanceof ServerApiError) return apiErrorResponse(error);
      if (error instanceof AccessFilterResolutionError) return explicitStartError(error);
      if (deadline.didExpire()) return errorResponse(504, "DEADLINE_EXCEEDED", "Route generation exceeded the server deadline");
      if (request.signal.aborted || isCancellationError(error)) {
        return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
      }
      return errorResponse(500, "INTERNAL_ERROR", "Route generation failed unexpectedly");
    } finally {
      deadline.dispose();
      if (repository) {
        try { await repository.close(); } catch { /* Read-only close cannot replace the request result. */ }
      }
    }
  };
}
