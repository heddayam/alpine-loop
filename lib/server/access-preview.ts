import { z } from "zod";
import { accessFilterV2Schema, accessPointRemotenessSelectionSchema } from "@/lib/contracts";
import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  type AccessPointCandidate,
  type GraphRepository,
} from "@/lib/graph";
import { classifyRemoteness } from "@/lib/data/remoteness";
import { apiErrorResponse, isCancellationError, ServerApiError } from "./api-error";
import { resolveAccessFilter, type ReachabilityResolver } from "./access-filter";
import type { RoutePack } from "./route-pack";

const accessPreviewRequestSchema = z.object({
  accessFilter: accessFilterV2Schema,
  includeUncertainAccess: z.boolean(),
  accessPointRemoteness: accessPointRemotenessSelectionSchema,
}).strict();

export type AccessPreviewDependencies = {
  packs: ReadonlyMap<string, RoutePack>;
  resolveReachability: ReachabilityResolver;
};

function candidateRank(left: AccessPointCandidate, right: AccessPointCandidate, includeUnknown: boolean): number {
  const connectivity = includeUnknown ? "inclusiveConnectivity" : "knownConnectivity";
  const degree = includeUnknown ? "inclusiveOutDegree" : "knownOutDegree";
  return right[connectivity] - left[connectivity]
    || right[degree] - left[degree]
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

export function createAccessPreviewHandler(dependencies: AccessPreviewDependencies) {
  return async function POST(request: Request, packId: string): Promise<Response> {
    if (request.signal.aborted) return apiErrorResponse(new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499));
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      if (request.signal.aborted || isCancellationError(error)) {
        return apiErrorResponse(new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499));
      }
      return apiErrorResponse(new ServerApiError("MALFORMED_JSON", "Request body must be valid JSON.", 400));
    }
    const parsed = accessPreviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiErrorResponse(new ServerApiError("INVALID_REQUEST", "Request body does not match the access-preview contract.", 400, {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      }));
    }
    const pack = dependencies.packs.get(packId);
    if (!pack) return apiErrorResponse(new ServerApiError("PACK_NOT_FOUND", `Pack '${packId}' is not installed.`, 404));

    let repository: GraphRepository | undefined;
    try {
      const resolved = await resolveAccessFilter(pack, parsed.data.accessFilter, dependencies.resolveReachability, request.signal);
      repository = await pack.loadRepository(request.signal);
      const candidates = await repository.getAccessPointCandidates({
        bbox: areaBounds(pack.coverage),
        includeUncertainAccess: true,
        signal: request.signal,
      });
      const eligible = candidates
        .filter((candidate) => resolved.predicates.every((geometry) =>
          coordinateIsInsideArea([candidate.lon, candidate.lat], geometry)))
        .filter((candidate) => accessPointIsEligible(candidate, parsed.data.includeUncertainAccess))
        .filter((candidate) => parsed.data.accessPointRemoteness.includes(classifyRemoteness(candidate)))
        .sort((left, right) => candidateRank(left, right, parsed.data.includeUncertainAccess));
      return Response.json({
        resolvedAccessFilter: resolved.summary,
        filterGeometry: resolved.filterGeometry,
        ...(resolved.refinementGeometry ? { refinementGeometry: resolved.refinementGeometry } : {}),
        accessPoints: eligible.map((point) => ({
          id: point.id,
          name: point.name,
          kind: point.kind,
          lon: point.lon,
          lat: point.lat,
          accessState: point.accessState,
          confidence: point.confidence,
          parkingEvidence: point.parkingEvidence,
          populationWithinRadius: point.populationWithinRadius,
          localReliefM: point.localReliefM,
          remoteness: classifyRemoteness(point),
        })),
      });
    } catch (error) {
      if (error instanceof ServerApiError) return apiErrorResponse(error);
      if (request.signal.aborted || isCancellationError(error)) {
        return apiErrorResponse(new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499));
      }
      return apiErrorResponse(new ServerApiError("PACK_UNAVAILABLE", `Pack '${packId}' could not be queried.`, 503));
    } finally {
      if (repository) {
        try { await repository.close(); } catch { /* Do not replace the result. */ }
      }
    }
  };
}
