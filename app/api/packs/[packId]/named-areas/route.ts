import { createNamedAreaSearchHandler } from "@/lib/server/named-areas-api";
import { loadRoutePacks } from "@/lib/server/pack-registry";

export async function GET(
  request: Request,
  context: { params: Promise<{ packId: string }> },
): Promise<Response> {
  const [{ packId }, packs] = await Promise.all([context.params, loadRoutePacks()]);
  return createNamedAreaSearchHandler({ packs })(request, packId);
}
