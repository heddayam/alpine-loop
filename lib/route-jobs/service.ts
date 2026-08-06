import {
  createBatchRouteJobV1Schema,
  routeJobListSchema,
  routeJobResultsPageSchema,
  type RouteJob,
  type RouteJobResultsPage,
  type RouteJobResult,
} from "@/lib/contracts";
import { isCancellationError, ServerApiError } from "@/lib/server/api-error";
import { SQLiteRouteJobStore, type ResultCursor } from "./store";
import type { RouteJobRunnerDependencies } from "./types";

const RESULT_PAGE_SIZE = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Batch route search failed unexpectedly.";
}

export function encodeResultCursor(cursor: ResultCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeResultCursor(value: string | undefined): ResultCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if ((parsed.matchRank !== 0 && parsed.matchRank !== 1)
      || !Number.isSafeInteger(parsed.accessOrdinal) || Number(parsed.accessOrdinal) < 0
      || !Number.isSafeInteger(parsed.resultOrdinal) || Number(parsed.resultOrdinal) < 0
      || typeof parsed.routeId !== "string" || parsed.routeId.length === 0) throw new Error();
    return {
      matchRank: parsed.matchRank,
      accessOrdinal: Number(parsed.accessOrdinal),
      resultOrdinal: Number(parsed.resultOrdinal),
      routeId: parsed.routeId,
    };
  } catch {
    throw new ServerApiError("INVALID_CURSOR", "The results cursor is invalid.", 400);
  }
}

export class RouteJobService {
  readonly #store: SQLiteRouteJobStore;
  readonly #dependencies: RouteJobRunnerDependencies;
  readonly #id: () => string;
  #active: { id: string; controller: AbortController } | undefined;
  #pump: Promise<void> | undefined;

  constructor(options: {
    store: SQLiteRouteJobStore;
    dependencies: RouteJobRunnerDependencies;
    id?: () => string;
  }) {
    this.#store = options.store;
    this.#dependencies = options.dependencies;
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.start();
  }

  start(): void {
    if (this.#pump) return;
    this.#pump = this.#runPump().finally(() => {
      this.#pump = undefined;
      if (this.#store.listIds().some((id) => this.#store.getStored(id)?.status === "queued")) this.start();
    });
  }

  async waitUntilIdle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  async create(raw: unknown, signal: AbortSignal = new AbortController().signal): Promise<RouteJob> {
    const parsed = createBatchRouteJobV1Schema.safeParse(raw);
    if (!parsed.success) {
      throw new ServerApiError("INVALID_REQUEST", "Request body does not match the batch route-job contract.", 400, {
        issues: parsed.error.issues.map(({ path, message }) => ({ path: path.map(String).join("."), message })),
      });
    }
    let resolved;
    try {
      resolved = await this.#dependencies.resolveJob(parsed.data, signal);
    } catch (error) {
      if (error instanceof ServerApiError) throw error;
      if (signal.aborted || isCancellationError(error)) throw new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499);
      throw new ServerApiError("BATCH_JOB_UNAVAILABLE", errorMessage(error), 503);
    }
    if (resolved.pack.id !== parsed.data.packId || resolved.searchRegion.id !== parsed.data.searchRegionId) {
      throw new ServerApiError("INVALID_BATCH_RESOLUTION", "The resolved pack or search region does not match the request.", 500);
    }
    const id = this.#id();
    this.#store.create(id, parsed.data, resolved);
    this.start();
    return (await this.get(id))!;
  }

  async list(): Promise<RouteJob[]> {
    const jobs = await Promise.all(this.#store.listIds().map((id) => this.get(id)));
    return routeJobListSchema.parse({ version: 1, jobs: jobs.filter((job): job is RouteJob => job !== null) }).jobs;
  }

  async get(id: string): Promise<RouteJob | null> {
    const stored = this.#store.getStored(id);
    if (!stored) return null;
    const current = await this.#dependencies.currentDataVersion(stored.pack.id).catch(() => null);
    return this.#store.toPublic(id, current !== null && current !== stored.pack.dataVersion);
  }

  async cancel(id: string): Promise<RouteJob> {
    const outcome = this.#store.requestCancel(id);
    if (outcome === "missing") throw new ServerApiError("ROUTE_JOB_NOT_FOUND", "That batch route job was not found.", 404);
    if (outcome === "requested" && this.#active?.id === id) this.#active.controller.abort(new DOMException("Cancelled", "AbortError"));
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    const outcome = this.#store.requestDelete(id);
    if (outcome === "missing") throw new ServerApiError("ROUTE_JOB_NOT_FOUND", "That batch route job was not found.", 404);
    if (outcome === "requested" && this.#active?.id === id) this.#active.controller.abort(new DOMException("Deleted", "AbortError"));
  }

  async results(id: string, cursorText?: string): Promise<RouteJobResultsPage> {
    const job = await this.get(id);
    if (!job) throw new ServerApiError("ROUTE_JOB_NOT_FOUND", "That batch route job was not found.", 404);
    if (!(["completed", "cancelled"] as const).includes(job.status as "completed" | "cancelled")) {
      throw new ServerApiError("ROUTE_JOB_RESULTS_NOT_READY", "Results are available after the job completes or is cancelled.", 409);
    }
    const page = this.#store.pageResults(id, decodeResultCursor(cursorText), RESULT_PAGE_SIZE);
    return routeJobResultsPageSchema.parse({
      version: 1,
      job,
      results: page.results,
      ...(page.next ? { nextCursor: encodeResultCursor(page.next) } : {}),
    });
  }

  async #runPump(): Promise<void> {
    for (;;) {
      const job = this.#store.claimNext();
      if (!job) return;
      const controller = new AbortController();
      this.#active = { id: job.id, controller };
      try {
        await this.#runJob(job.id, controller.signal);
      } catch (error) {
        const latest = this.#store.getStored(job.id);
        if (!latest) continue;
        if (latest.deleteRequested || latest.status === "deleting") this.#store.delete(job.id);
        else if (latest.cancelRequested || controller.signal.aborted || isCancellationError(error)) this.#store.finish(job.id, "cancelled");
        else this.#store.finish(job.id, "failed", errorMessage(error));
      } finally {
        if (this.#store.getStored(job.id)?.deleteRequested) this.#store.delete(job.id);
        this.#active = undefined;
      }
    }
  }

  async #runJob(id: string, signal: AbortSignal): Promise<void> {
    let job = this.#store.getStored(id);
    if (!job) return;
    if (!job.geometry) {
      const driveTime = await this.#dependencies.resolveDriveTime(job.request, signal);
      if (signal.aborted) throw signal.reason;
      this.#store.saveDriveTime(id, driveTime);
      job = this.#store.getStored(id)!;
    }
    if (!job.geometry) throw new Error("Drive-time geometry was not persisted");

    const ids = await this.#dependencies.enumerateEligibleAccessPointIds({
      request: job.request,
      pack: job.pack,
      searchRegionId: job.searchRegion.id,
      driveTimeGeometry: job.geometry,
      signal,
    });
    if (signal.aborted) throw signal.reason;
    this.#store.initializeAccessPoints(id, ids);

    for (;;) {
      if (signal.aborted) throw signal.reason;
      const latest = this.#store.getStored(id);
      if (!latest || latest.cancelRequested || latest.deleteRequested) throw new DOMException("Cancelled", "AbortError");
      const point = this.#store.nextAccessPoint(id);
      if (!point) break;
      try {
        const searched = await this.#dependencies.searchAccessPoint({
          request: latest.request,
          pack: latest.pack,
          searchRegionId: latest.searchRegion.id,
          driveTimeGeometry: latest.geometry!,
          accessPointId: point.accessPointId,
          signal,
        });
        if (signal.aborted) throw signal.reason;
        const results: RouteJobResult[] = searched.exact.slice(0, latest.request.routesPerAccessPoint).map((route) => ({
          matchType: "exact", accessPointId: point.accessPointId, route,
        }));
        if (results.length === 0 && searched.nearMisses[0]) results.push({
          matchType: "near-miss", accessPointId: point.accessPointId, route: searched.nearMisses[0],
        });
        this.#store.completeAccessPoint(id, point.ordinal, results, searched.truncated, searched.diagnostics);
      } catch (error) {
        if (signal.aborted || isCancellationError(error)) throw error;
        this.#store.failAccessPoint(id, point.ordinal, errorMessage(error));
      }
    }
    const latest = this.#store.getStored(id);
    if (!latest) return;
    if (latest.deleteRequested) this.#store.delete(id);
    else if (latest.cancelRequested) this.#store.finish(id, "cancelled");
    else this.#store.finish(id, "completed");
  }
}
