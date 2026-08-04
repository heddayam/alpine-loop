import {
  generateRoutesRequestV1Schema,
  generateRoutesResponseV1Schema,
  type GenerateRoutesRequestV1,
  type GenerateRoutesResponseV1,
} from "@/lib/contracts";
import type { GraphRepository } from "@/lib/graph";
import { DEFAULT_SOLVER_BUDGET, type RouteSolver, type SolverBudget } from "@/lib/solver";

const EARTH_RADIUS_KILOMETERS = 6_371.0088;

export type RoutePack = {
  id: string;
  schemaVersion: string;
  dataVersion: string;
  builtAt: string;
  coverageBbox: readonly [west: number, south: number, east: number, north: number];
  maximumAreaSquareKilometers: number;
  loadRepository: (signal: AbortSignal) => Promise<GraphRepository>;
};

export type RouteGenerationDependencies = {
  packs: ReadonlyMap<string, RoutePack>;
  solver: RouteSolver;
  budget?: SolverBudget;
};

type ApiErrorCode =
  | "MALFORMED_JSON"
  | "INVALID_REQUEST"
  | "PACK_NOT_FOUND"
  | "BOUNDARY_OUTSIDE_COVERAGE"
  | "BOUNDARY_TOO_LARGE"
  | "PACK_UNAVAILABLE"
  | "REQUEST_CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "INVALID_SOLVER_RESPONSE"
  | "INTERNAL_ERROR";

type ApiErrorDetails = Record<string, unknown>;

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: ApiErrorDetails,
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

function rectangleAreaSquareKilometers(
  [west, south, east, north]: GenerateRoutesRequestV1["bbox"],
): number {
  const longitudeRadians = ((east - west) * Math.PI) / 180;
  const latitudeBand =
    Math.sin((north * Math.PI) / 180) - Math.sin((south * Math.PI) / 180);
  return Math.abs(EARTH_RADIUS_KILOMETERS ** 2 * longitudeRadians * latitudeBand);
}

function boundaryIsInsideCoverage(
  [west, south, east, north]: GenerateRoutesRequestV1["bbox"],
  [coverageWest, coverageSouth, coverageEast, coverageNorth]: RoutePack["coverageBbox"],
): boolean {
  return (
    west >= coverageWest &&
    south >= coverageSouth &&
    east <= coverageEast &&
    north <= coverageNorth
  );
}

function positionIsInsideBoundary(
  [lon, lat]: readonly [number, number],
  [west, south, east, north]: GenerateRoutesRequestV1["bbox"],
): boolean {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function responseSemanticIssue(
  response: GenerateRoutesResponseV1,
  request: GenerateRoutesRequestV1,
  pack: RoutePack,
): string | undefined {
  if (response.requested !== request.limit) return "The response requested count does not match the request";
  if (
    response.pack.id !== pack.id ||
    response.pack.schemaVersion !== pack.schemaVersion ||
    response.pack.dataVersion !== pack.dataVersion ||
    response.pack.builtAt !== pack.builtAt
  ) {
    return "The response pack metadata does not match the loaded pack";
  }

  const routes = [...response.exact, ...response.nearMisses];
  if (response.exact.length > request.limit) return "The response contains more exact routes than requested";
  if (routes.some((route) => route.geometry.coordinates.some((position) => !positionIsInsideBoundary(position, request.bbox)))) {
    return "A response route leaves the requested hard boundary";
  }
  if (
    response.exact.length < request.limit &&
    !response.diagnostics.exhausted &&
    response.diagnostics.truncationReasons.length === 0
  ) {
    return "A response with fewer routes than requested must explain why in diagnostics";
  }
  return undefined;
}

function validationDetails(issues: Array<{ path: PropertyKey[]; message: string }>): ApiErrorDetails {
  return {
    issues: issues.map(({ path, message }) => ({
      path: path.map(String).join("."),
      message,
    })),
  };
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && ["AbortError", "RouteSearchCancelledError"].includes(error.name)
  );
}

function deadlineSignal(
  requestSignal: AbortSignal,
  deadlineMs: number,
): { signal: AbortSignal; didExpire: () => boolean; dispose: () => void } {
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

export function createGenerateRoutesHandler(
  dependencies: RouteGenerationDependencies,
): (request: Request) => Promise<Response> {
  const budget = dependencies.budget ?? DEFAULT_SOLVER_BUDGET;

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

    const parsedRequest = generateRoutesRequestV1Schema.safeParse(body);
    if (!parsedRequest.success) {
      return errorResponse(
        400,
        "INVALID_REQUEST",
        "Request body does not match the route-generation contract",
        validationDetails(parsedRequest.error.issues),
      );
    }
    const routeRequest = parsedRequest.data;
    const pack = dependencies.packs.get(routeRequest.packId);
    if (!pack) {
      return errorResponse(
        404,
        "PACK_NOT_FOUND",
        `Pack '${routeRequest.packId}' is not installed`,
        { supportedPackIds: [...dependencies.packs.keys()].sort() },
      );
    }
    if (!boundaryIsInsideCoverage(routeRequest.bbox, pack.coverageBbox)) {
      return errorResponse(
        422,
        "BOUNDARY_OUTSIDE_COVERAGE",
        "Draw a rectangle entirely inside the selected pack coverage",
        { coverageBbox: pack.coverageBbox },
      );
    }

    const areaSquareKilometers = rectangleAreaSquareKilometers(routeRequest.bbox);
    if (areaSquareKilometers > pack.maximumAreaSquareKilometers) {
      return errorResponse(
        422,
        "BOUNDARY_TOO_LARGE",
        "Draw a smaller rectangle before generating routes",
        {
          areaSquareKilometers,
          maximumAreaSquareKilometers: pack.maximumAreaSquareKilometers,
        },
      );
    }

    const deadline = deadlineSignal(request.signal, budget.deadlineMs);
    let repository: GraphRepository | undefined;
    try {
      try {
        repository = await pack.loadRepository(deadline.signal);
      } catch (error) {
        if (deadline.didExpire()) {
          return errorResponse(
            504,
            "DEADLINE_EXCEEDED",
            "Opening the local pack exceeded the server deadline; verify the pack installation",
            { deadlineMs: budget.deadlineMs },
          );
        }
        if (request.signal.aborted || isCancellationError(error)) {
          return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
        }
        return errorResponse(
          503,
          "PACK_UNAVAILABLE",
          `Pack '${pack.id}' could not be opened; rebuild or reinstall the local pack`,
        );
      }
      const solverResponse = await dependencies.solver.generate(routeRequest, {
        repository,
        budget,
        signal: deadline.signal,
      });
      const parsedResponse = generateRoutesResponseV1Schema.safeParse(solverResponse);
      if (!parsedResponse.success) {
        return errorResponse(
          500,
          "INVALID_SOLVER_RESPONSE",
          "The route solver returned an invalid response",
          validationDetails(parsedResponse.error.issues),
        );
      }
      const semanticIssue = responseSemanticIssue(parsedResponse.data, routeRequest, pack);
      if (semanticIssue) {
        return errorResponse(500, "INVALID_SOLVER_RESPONSE", semanticIssue);
      }
      return Response.json(parsedResponse.data);
    } catch (error) {
      if (deadline.didExpire()) {
        return errorResponse(
          504,
          "DEADLINE_EXCEEDED",
          "Route generation exceeded the server deadline; draw a smaller rectangle or narrow the constraints",
          { deadlineMs: budget.deadlineMs },
        );
      }
      if (request.signal.aborted || isCancellationError(error)) {
        return errorResponse(499, "REQUEST_CANCELLED", "Route generation was cancelled by the client");
      }
      return errorResponse(500, "INTERNAL_ERROR", "Route generation failed unexpectedly");
    } finally {
      deadline.dispose();
      if (repository) {
        try {
          await repository.close();
        } catch {
          // The request result is already determined; a failed read-only close must not replace it.
        }
      }
    }
  };
}
