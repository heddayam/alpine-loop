import { createAccessPreviewHandler } from "@/lib/server/access-preview";
import { defaultReachabilityResolver } from "@/lib/server/default-reachability-resolution";
import { loadRoutePacks } from "@/lib/server/pack-registry";

export async function POST(
  request: Request,
  context: { params: Promise<{ packId: string }> },
): Promise<Response> {
  const [{ packId }, packs] = await Promise.all([context.params, loadRoutePacks()]);
  return createAccessPreviewHandler({ packs, resolveReachability: defaultReachabilityResolver })(request, packId);
}
