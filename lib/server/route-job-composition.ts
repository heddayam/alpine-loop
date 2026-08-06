import { resolve } from "node:path";
import { getSearchRegion } from "@/lib/data/named-area-catalog";
import {
  SQLiteClosedRouteFeasibilityRepository,
  SQLiteGraphRepository,
} from "@/lib/graph";
import { loadInstalledPack, loadInstalledPackVersion } from "@/lib/packs/installed-pack";
import { defaultReachabilityService } from "@/lib/reachability/default-service";
import type { ReachabilityService } from "@/lib/reachability/service";
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

const DRIVE_TIME_RESOLUTION_DEADLINE_MS = 2 * 60 * 1_000;

type DriveTimeService = Pick<ReachabilityService, "submit" | "poll">;

export async function resolveBatchDriveTime(
  service: DriveTimeService,
  request: Parameters<DriveTimeService["submit"]>[0],
  signal: AbortSignal,
  options: {
    deadlineMs?: number;
    delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  if (signal.aborted) abortFromParent();
  else signal.addEventListener("abort", abortFromParent, { once: true });
  const deadlineMs = options.deadlineMs ?? DRIVE_TIME_RESOLUTION_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Drive-time resolution exceeded ${deadlineMs} ms.`);
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      let response = await service.submit(request, controller.signal);
      while (response.status === "pending") {
        await (options.delay ?? abortableDelay)(response.pollAfterMs, controller.signal);
        response = await service.poll(response.requestId, controller.signal);
      }
      return { geometry: response.geometry, resolvedAt: response.resolvedAt };
    })()]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abortFromParent);
  }
}

function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolveYield) => setImmediate(resolveYield)).then(() => {
    if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
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
      return resolveBatchDriveTime(defaultReachabilityService(), {
        version: 1,
        packId: request.packId,
        origin: request.origin,
        durationMinutes: request.durationMinutes,
      }, signal);
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
          const run = (searchEffort: "quick" | "thorough") => solver.generate({
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
              searchEffort,
              limit: input.request.routesPerAccessPoint,
            }, {
              repository,
              topologyRepository,
              accessFilter,
              budget: { ...CLOSED_ROUTE_EFFORT_BUDGETS[searchEffort] },
              signal,
            });
          const quick = await run("quick");
          await yieldToEventLoop(signal);
          const thorough = await run("thorough");
          const unique = <T extends { id: string }>(values: readonly T[]): T[] => {
            const seen = new Set<string>();
            return values.filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)));
          };
          return {
            exact: unique([...quick.exact, ...thorough.exact]).slice(0, input.request.routesPerAccessPoint),
            nearMisses: unique([...thorough.nearMisses, ...quick.nearMisses]),
            truncated: quick.diagnostics.hardTruncationReasons.length > 0
              || thorough.diagnostics.hardTruncationReasons.length > 0,
            diagnostics: { quick: quick.diagnostics, thorough: thorough.diagnostics },
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
