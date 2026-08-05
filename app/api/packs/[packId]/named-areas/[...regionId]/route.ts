import { createNamedAreaDetailHandler } from "@/lib/server/named-areas-api";
import { loadRoutePacks } from "@/lib/server/pack-registry";

export async function GET(
  request: Request,
  context: { params: Promise<{ packId: string; regionId: string[] }> },
): Promise<Response> {
  const [{ packId, regionId }, packs] = await Promise.all([context.params, loadRoutePacks()]);
  return createNamedAreaDetailHandler({ packs })(request, packId, regionId.join("/"));
}
