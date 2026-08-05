import { defaultReachabilityService } from "@/lib/reachability/default-service";
import { ServerApiError } from "./api-error";
import type { ReachabilityResolver, ResolvedReachability } from "./access-filter";

type RouteGenerationReachabilityService = {
  resolveCompleted?: (
    id: string,
    packId: string,
  ) => ResolvedReachability | Promise<ResolvedReachability>;
};

export const defaultReachabilityResolver: ReachabilityResolver = async (id, packId) => {
  const service = defaultReachabilityService() as RouteGenerationReachabilityService;
  if (!service.resolveCompleted) {
    throw new ServerApiError(
      "REACHABILITY_UNAVAILABLE",
      "Drive-time route generation is not available until the reachability resolver is configured.",
      503,
    );
  }
  return service.resolveCompleted(id, packId);
};
