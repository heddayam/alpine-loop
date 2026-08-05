import {
  ReachableGraphClosedRouteSolver,
} from "@/lib/solver";
import { createGenerateClosedRoutesHandler } from "./closed-route-generation";
import { defaultReachabilityResolver } from "./default-reachability-resolution";
import { loadRoutePacks } from "./pack-registry";

export async function POST(request: Request): Promise<Response> {
  const packs = await loadRoutePacks();
  return createGenerateClosedRoutesHandler({
    packs,
    createSolver: (pack) => {
      const registered = packs.get(pack.id);
      if (!registered) throw new Error(`Pack ${pack.id} is not registered`);
      return new ReachableGraphClosedRouteSolver({
        pack: {
          id: pack.id,
          schemaVersion: pack.schemaVersion,
          dataVersion: pack.dataVersion,
          builtAt: pack.builtAt,
        },
        sourceFreshness: registered.sourceFreshness,
        sourceConfidence: registered.sourceConfidence,
        fallbackSourceIds: registered.fallbackSourceIds,
      });
    },
    resolveReachability: defaultReachabilityResolver,
  })(request);
}
