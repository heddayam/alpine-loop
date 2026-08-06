import { createSearchRegionListHandler } from "@/lib/server/search-regions-api";
import { loadRoutePacks } from "@/lib/server/pack-registry";

export async function GET(
  request: Request,
  context: { params: Promise<{ packId: string }> },
): Promise<Response> {
  const [{ packId }, packs] = await Promise.all([context.params, loadRoutePacks()]);
  return createSearchRegionListHandler({ packs })(request, packId);
}
