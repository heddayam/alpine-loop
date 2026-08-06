import { resolve } from "node:path";
import { loadInstalledPack } from "@/lib/packs/installed-pack";
import { defaultReachabilityService } from "@/lib/reachability/default-service";
import type { ReachabilityService } from "@/lib/reachability/service";
import {
  RouteJobService,
  SQLiteRouteJobStore,
  type RouteJobRunnerDependencies,
} from "@/lib/route-jobs";
import { ServerApiError } from "./api-error";
import { loadRoutePacks } from "./pack-registry";
import { RouteJobSolverProcess } from "./route-job-solver-process";

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
      const { signal, ...workerInput } = input;
      return RouteJobSolverProcess.open(workerInput, signal);
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
