import { areaGeometrySchema, searchIntentSchema, routeJobResultsPageV2Schema } from "@/lib/contracts";
import { isCancellationError, ServerApiError } from "@/lib/server/api-error";
import { SQLiteRouteJobStore, type ResultCursor, type StoredJob } from "./store";
import type { RouteJobRunnerDependencies, RouteJob, RouteJobResultsPage, RouteJobResult } from "./types";

const RESULT_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 2_048;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Batch route search failed unexpectedly.";
}

function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
  });
}

export function encodeResultCursor(cursor: ResultCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeResultCursor(value: string | undefined): ResultCursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > MAX_CURSOR_LENGTH) throw new Error();
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
      if (this.#store.hasQueued()) this.start();
    });
  }

  async waitUntilIdle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  async create(raw: unknown, signal: AbortSignal = new AbortController().signal): Promise<RouteJob> {
    const parsed = searchIntentSchema.safeParse(raw);
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
    if (signal.aborted) throw new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499);
    const id = this.#id();
    this.#store.create(id, parsed.data, resolved);
    this.start();
    return (await this.get(id))!;
  }

  async list(): Promise<RouteJob[]> {
    const stored = this.#store.listIds()
      .map((id) => this.#store.getStored(id))
      .filter((job): job is NonNullable<typeof job> => job !== null);
    const versions = new Map(await Promise.all([...new Set(stored.flatMap(({ plan }) => plan.packs.map(({ id }) => id)))].map(async (packId) => [
      packId,
      await this.#dependencies.currentDataVersion(packId).catch(() => null),
    ] as const)));
    return stored.flatMap(({ id, plan }) => {
      const job = this.#store.toPublic(id, plan.packs.some((pack) => versions.get(pack.id) !== pack.dataVersion));
      return job ? [job] : [];
    });
  }

  async get(id: string): Promise<RouteJob | null> {
    const stored = this.#store.getStored(id);
    if (!stored) return null;
    const changed = await Promise.all(stored.plan.packs.map(async (pack) =>
      (await this.#dependencies.currentDataVersion(pack.id).catch(() => null)) !== pack.dataVersion));
    return this.#store.toPublic(id, changed.some(Boolean));
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
    return routeJobResultsPageV2Schema.parse({
      version: 2,
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
        await this.#runJob(job, controller.signal);
        this.#store.finish(job.id, "completed");
      } catch (error) {
        this.#store.finish(job.id, controller.signal.aborted || isCancellationError(error) ? "cancelled" : "failed", errorMessage(error));
      } finally {
        this.#active = undefined;
      }
    }
  }

  async #runJob(job: StoredJob, signal: AbortSignal): Promise<void> {
    const { id, request } = job;
    let { plan } = job;
    if (request.area.mode === "drive-time" && !plan.area.filterGeometry) {
      const resolved = await this.#dependencies.resolveDriveTime(request.area, signal);
      const driveTime = { ...resolved, geometry: areaGeometrySchema.parse(resolved.geometry) };
      if (signal.aborted) throw signal.reason;
      this.#store.saveDriveTime(id, driveTime);
      plan = { ...plan, area: { ...plan.area, filterGeometry: driveTime.geometry } };
    }
    await yieldToEventLoop(signal);
    const session = await this.#dependencies.openSearchSession({ request, plan, signal });
    try {
      await yieldToEventLoop(signal);
      const ids = await session.enumerateEligibleAccessPointIds(signal);
      await yieldToEventLoop(signal);
      if (signal.aborted) throw signal.reason;
      this.#store.initializeAccessPoints(id, ids);
      await yieldToEventLoop(signal);

      for (;;) {
        if (signal.aborted) throw signal.reason;
        const latest = this.#store.getControl(id);
        if (!latest || latest.cancelRequested || latest.deleteRequested) throw new DOMException("Cancelled", "AbortError");
        const point = this.#store.nextAccessPoint(id);
        if (!point) break;
        try {
          const searched = await session.searchAccessPoint(point.accessPointId, signal);
          if (signal.aborted) throw signal.reason;
          const results: RouteJobResult[] = searched.exact.slice(0, 10).map((route) => ({
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
        // The solver and SQLite checkpoints are local CPU/synchronous work.
        // Yield between trailheads so progress polling and cancellation remain
        // responsive while a long FIFO job is running.
        await yieldToEventLoop(signal);
      }
    } finally {
      await session.close();
    }
  }
}
