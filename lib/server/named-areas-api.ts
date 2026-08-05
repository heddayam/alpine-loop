import { apiErrorResponse, ServerApiError } from "./api-error";
import type { RoutePack } from "./route-pack";

export type NamedAreaApiDependencies = { packs: ReadonlyMap<string, RoutePack> };

function requirePack(dependencies: NamedAreaApiDependencies, packId: string): RoutePack {
  const pack = dependencies.packs.get(packId);
  if (!pack) throw new ServerApiError("PACK_NOT_FOUND", `Pack '${packId}' is not installed.`, 404);
  return pack;
}

export function createNamedAreaSearchHandler(dependencies: NamedAreaApiDependencies) {
  return async function GET(request: Request, packId: string): Promise<Response> {
    try {
      const pack = requirePack(dependencies, packId);
      if (!pack.searchNamedAreas) throw new ServerApiError("NAMED_AREAS_UNAVAILABLE", "This pack does not provide named regions.", 422);
      const url = new URL(request.url);
      const text = url.searchParams.get("q")?.trim() ?? "";
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 10 : Number(limitText);
      if (text.length < 2 || text.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new ServerApiError("INVALID_REQUEST", "Named-region search requires q of 2–200 characters and limit of 1–50.", 400);
      }
      return Response.json({ regions: await pack.searchNamedAreas(text, limit) });
    } catch (error) {
      return apiErrorResponse(error instanceof ServerApiError
        ? error
        : new ServerApiError("PACK_UNAVAILABLE", "Named regions could not be searched.", 503));
    }
  };
}

export function createNamedAreaDetailHandler(dependencies: NamedAreaApiDependencies) {
  return async function GET(_request: Request, packId: string, regionId: string): Promise<Response> {
    try {
      const pack = requirePack(dependencies, packId);
      if (!pack.getNamedArea) throw new ServerApiError("NAMED_AREAS_UNAVAILABLE", "This pack does not provide named regions.", 422);
      const region = await pack.getNamedArea(regionId);
      if (!region) throw new ServerApiError("NAMED_AREA_NOT_FOUND", `Named region '${regionId}' was not found.`, 404);
      return Response.json({ region });
    } catch (error) {
      return apiErrorResponse(error instanceof ServerApiError
        ? error
        : new ServerApiError("PACK_UNAVAILABLE", "The named region could not be loaded.", 503));
    }
  };
}
