import { apiErrorResponse, ServerApiError } from "./api-error";
import type { RoutePack } from "./route-pack";

export type SearchRegionApiDependencies = { packs: ReadonlyMap<string, RoutePack> };

export function createSearchRegionListHandler(dependencies: SearchRegionApiDependencies) {
  return async function GET(_request: Request, packId: string): Promise<Response> {
    try {
      const pack = dependencies.packs.get(packId);
      if (!pack) throw new ServerApiError("PACK_NOT_FOUND", `Pack '${packId}' is not installed.`, 404);
      if (!pack.listSearchRegions) {
        throw new ServerApiError("SEARCH_REGIONS_UNAVAILABLE", "This pack does not provide reviewed batch-search regions.", 422);
      }
      return Response.json({ regions: await pack.listSearchRegions() });
    } catch (error) {
      return apiErrorResponse(error instanceof ServerApiError
        ? error
        : new ServerApiError("PACK_UNAVAILABLE", "Batch-search regions could not be loaded.", 503));
    }
  };
}
