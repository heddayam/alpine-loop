import { resolve } from "node:path";
import { loadInstalledPack } from "@/lib/packs/installed-pack";
import { defaultReachabilityService } from "@/lib/reachability/default-service";
import { RouteJobService, SQLiteRouteJobStore, type RouteJobRunnerDependencies } from "@/lib/route-jobs";
import { resolveSearchPlan } from "./search-area";
import { openSearchSession } from "./search";

declare global {
  var alpineRouteJobDependencies: RouteJobRunnerDependencies | undefined;
  var alpineRouteJobService: RouteJobService | undefined;
}

function defaultRuntimeDependencies(): RouteJobRunnerDependencies {
  return {
    resolveJob: resolveSearchPlan,
    resolveDriveTime: (area, signal) => defaultReachabilityService().resolveArea(area, signal),
    async currentDataVersion(packId) {
      return (await loadInstalledPack(packId))?.manifest.dataVersion ?? null;
    },
    openSearchSession,
  };
}

/** Override the concrete local runtime before first use, primarily for tests. */
export function configureRouteJobRuntime(dependencies: RouteJobRunnerDependencies): void {
  if (globalThis.alpineRouteJobService) throw new Error("Route-job runtime was configured after service initialization");
  globalThis.alpineRouteJobDependencies = dependencies;
}

export function defaultRouteJobService(): RouteJobService {
  globalThis.alpineRouteJobService ??= new RouteJobService({
    store: new SQLiteRouteJobStore(process.env.ALPINE_ROUTE_JOBS_DB ?? resolve(process.cwd(), ".local-data/runtime/route-jobs.sqlite")),
    dependencies: globalThis.alpineRouteJobDependencies ?? defaultRuntimeDependencies(),
  });
  return globalThis.alpineRouteJobService;
}
