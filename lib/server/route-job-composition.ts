import { resolve } from "node:path";
import { getSearchRegion } from "@/lib/data/named-area-catalog";
import {
  SQLiteClosedRouteFeasibilityRepository,
  SQLiteGraphRepository,
} from "@/lib/graph";
import { loadInstalledPack, loadInstalledPackVersion } from "@/lib/packs/installed-pack";
import { defaultReachabilityService } from "@/lib/reachability/default-service";
import {
  RouteJobService,
  SQLiteRouteJobStore,
  type RouteJobRunnerDependencies,
} from "@/lib/route-jobs";
import {
  CLOSED_ROUTE_EFFORT_BUDGETS,
  listEligibleAccessPointCandidates,
  ReachableGraphClosedRouteSolver,
} from "@/lib/solver";
import { ServerApiError } from "./api-error";
import { resolvedDriveTimeAccessFilter } from "./access-filter";
import { loadRoutePacks } from "./pack-registry";

declare global {
  var alpineRouteJobDependencies: RouteJobRunnerDependencies | undefined;
  var alpineRouteJobService: RouteJobService | undefined;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function defaultRuntimeDependencies(): RouteJobRunnerDependencies {
  return {
    async resolveJob(request, signal) {
      if (signal.aborted) throw signal.reason;
      const pack = (await loadRoutePacks()).get(request.packId);
      if (!pack) throw new ServerApiError("PACK_NOT_FOUND", `Pack '${request.packId}' is not installed.`, 404);
      if (pack.schemaVersion !== "4" || !pack.getSearchRegion) {
        throw new ServerApiError("BATCH_SEARCH_UNAVAILABLE", "Rebuild this pack with reviewed batch-search regions.", 422);
      }
      const searchRegion = await pack.getSearchRegion(request.searchRegionId);
      if (!searchRegion) {
        throw new ServerApiError("SEARCH_REGION_NOT_FOUND", "That reviewed batch-search region was not found.", 404);
      }
      return {
        pack: { id: pack.id, dataVersion: pack.dataVersion, builtAt: pack.builtAt },
        searchRegion: { id: searchRegion.id, name: searchRegion.name },
      };
    },

    async resolveDriveTime(request, signal) {
      const service = defaultReachabilityService();
      let response = await service.submit({
        version: 1,
        packId: request.packId,
        origin: request.origin,
        durationMinutes: request.durationMinutes,
      }, signal);
      try {
        while (response.status === "pending") {
          await abortableDelay(response.pollAfterMs, signal);
          response = await service.poll(response.requestId, signal);
        }
        return { geometry: response.geometry, resolvedAt: response.resolvedAt };
      } catch (error) {
        if (signal.aborted && response.status === "pending") {
          await service.cancel(response.requestId).catch(() => undefined);
        }
        throw error;
      }
    },

    async currentDataVersion(packId) {
      return (await loadInstalledPack(packId))?.manifest.dataVersion ?? null;
    },

    async openSearchSession(input) {
      const installed = await loadInstalledPackVersion(input.pack.id, input.pack.dataVersion);
      if (!installed) throw new ServerApiError("PINNED_PACK_NOT_FOUND", "The pack version used by this job is no longer installed.", 409);
      const manifest = installed.manifest;
      if (manifest.schemaVersion !== "4") {
        throw new ServerApiError("PINNED_PACK_UNSUPPORTED", "The job's pack does not support batch search.", 422);
      }
      const region = getSearchRegion(installed.databasePath, input.searchRegionId);
      if (!region) throw new ServerApiError("SEARCH_REGION_NOT_FOUND", "The job's reviewed search region is unavailable.", 409);
      const accessFilter = resolvedDriveTimeAccessFilter({ coverage: manifest.coverage.boundary }, {
        geometry: input.driveTimeGeometry,
        durationMinutes: input.request.durationMinutes,
        resolvedAt: new Date().toISOString(),
        originLabel: input.request.origin.label,
      }, region);
      const repository = new SQLiteGraphRepository(installed.databasePath, manifest.id);
      const topologyRepository = new SQLiteClosedRouteFeasibilityRepository({
        databasePath: installed.databasePath,
        manifest,
      });
      const solver = new ReachableGraphClosedRouteSolver({
        pack: {
          id: manifest.id,
          schemaVersion: manifest.schemaVersion,
          dataVersion: manifest.dataVersion,
          builtAt: manifest.builtAt,
        },
        sourceFreshness: manifest.sources.map(({ retrievedAt }) => retrievedAt).sort()[0] ?? manifest.builtAt,
        sourceConfidence: manifest.fieldConfidence.access ?? "low",
        fallbackSourceIds: manifest.sources.map(({ id }) => id),
      });
      return {
        async enumerateEligibleAccessPointIds(signal) {
          const { eligible } = await listEligibleAccessPointCandidates({
            repository,
            accessFilter,
            includeUncertainAccess: input.request.criteria.includeUncertainAccess,
            accessPointRemoteness: input.request.criteria.accessPointRemoteness,
            signal,
          });
          return eligible.map(({ id }) => id);
        },
        async searchAccessPoint(accessPointId, signal) {
          const response = await solver.generate({
            version: 3,
            packId: manifest.id,
            accessFilter: {
              mode: "drive-time",
              reachabilityId: "00000000-0000-4000-8000-000000000000",
              regionId: region.id,
            },
            startAccessPointId: accessPointId,
            routeFamily: "closed",
            ...input.request.criteria,
            searchEffort: "thorough",
            limit: input.request.routesPerAccessPoint,
          }, {
            repository,
            topologyRepository,
            accessFilter,
            budget: { ...CLOSED_ROUTE_EFFORT_BUDGETS.thorough },
            signal,
          });
          return {
            exact: response.exact,
            nearMisses: response.nearMisses,
            truncated: response.diagnostics.hardTruncationReasons.length > 0,
            diagnostics: response.diagnostics,
          };
        },
        async close() {
          await topologyRepository.close();
          await repository.close();
        },
      };
    },
  };
}

/** Override the concrete local runtime before first use, primarily for tests. */
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
    dependencies: globalThis.alpineRouteJobDependencies ?? defaultRuntimeDependencies(),
  });
  return globalThis.alpineRouteJobService;
}
