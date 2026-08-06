import { resolve } from "node:path";
import { ServerApiError } from "./api-error";
import {
  RouteJobService,
  SQLiteRouteJobStore,
  type RouteJobRunnerDependencies,
} from "@/lib/route-jobs";

declare global {
  var alpineRouteJobDependencies: RouteJobRunnerDependencies | undefined;
  var alpineRouteJobService: RouteJobService | undefined;
}

const unavailable = async (): Promise<never> => {
  throw new ServerApiError(
    "BATCH_RUNTIME_UNAVAILABLE",
    "Batch route search is unavailable until the local pack runtime is configured.",
    503,
  );
};

const UNCONFIGURED: RouteJobRunnerDependencies = {
  resolveJob: unavailable,
  resolveDriveTime: unavailable,
  enumerateEligibleAccessPointIds: unavailable,
  searchAccessPoint: unavailable,
  currentDataVersion: async () => null,
};

/** Configure once during server composition, before the first route-job request. */
export function configureRouteJobRuntime(dependencies: RouteJobRunnerDependencies): void {
  if (globalThis.alpineRouteJobService) throw new Error("Route-job runtime was configured after service initialization");
  globalThis.alpineRouteJobDependencies = dependencies;
}

export function defaultRouteJobService(): RouteJobService {
  globalThis.alpineRouteJobService ??= new RouteJobService({
    store: new SQLiteRouteJobStore(
      process.env.ALPINE_ROUTE_JOBS_DB
        ?? resolve(process.cwd(), ".local-data/runtime/route-jobs.sqlite"),
    ),
    dependencies: globalThis.alpineRouteJobDependencies ?? UNCONFIGURED,
  });
  return globalThis.alpineRouteJobService;
}
