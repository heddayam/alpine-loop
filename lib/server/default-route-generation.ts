import { routeCriteriaSchema } from "@/lib/contracts";
import { createGenerateClosedRoutesHandler } from "./closed-route-generation";
import { defaultReachabilityResolver } from "./default-reachability-resolution";
import { loadRoutePacks } from "./pack-registry";
import { RouteSolverProcess } from "./route-solver-process";

export async function POST(request: Request): Promise<Response> {
  return createGenerateClosedRoutesHandler({
    packs: await loadRoutePacks(),
    async generate(pack, request, { accessFilter, budget, signal }) {
      const { searchEffort, limit, startAccessPointId } = request;
      const session = await RouteSolverProcess.open({
        pack,
        criteria: routeCriteriaSchema.strip().parse(request),
        accessFilter,
      }, signal);
      try {
        return await session.generate({ searchEffort, limit, startAccessPointId }, budget, signal);
      } finally {
        await session.close().catch(() => undefined);
      }
    },
    resolveReachability: defaultReachabilityResolver,
  })(request);
}
