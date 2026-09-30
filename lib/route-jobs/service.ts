import { ACCESS_ENTRY_POLICY_VERSION, areaGeometrySchema, searchIntentSchema, routeJobResultsPageV2Schema } from "@/lib/contracts";
import { isCancellationError, ServerApiError } from "@/lib/server/api-error";
import { SQLiteRouteJobStore, type ResultCursor, type StoredJob } from "./store";
import type { RouteJobRunnerDependencies, RouteJob, RouteJobResultsPage, RouteJobResult } from "./types";
import { retainBetterResults } from "./retain-results";

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
    const id = this.#id();
    for (let attempt = 0; attempt < 2; attempt++) {
      let resolved;
      try { resolved = await this.#dependencies.resolveJob(parsed.data, signal); }
      catch (error) {
        if (error instanceof ServerApiError) throw error;
        if (signal.aborted || isCancellationError(error)) throw new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499);
        throw new ServerApiError("BATCH_JOB_UNAVAILABLE", errorMessage(error), 503);
      }
      if (signal.aborted) throw new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499);
      if (!resolved.installationId) throw new ServerApiError("COVERAGE_REQUIRED", "Install prepared coverage and restart this search.", 409);
      try {
        await this.#dependencies.pinInstallation(resolved.installationId, async () => {
          this.#store.create(id, parsed.data, resolved);
        });
        this.start();
        return (await this.get(id))!;
      } catch (error) { if (attempt || this.#store.getStored(id)) throw error; }
    }
    throw new Error("Local coverage changed during route-job planning");
  }

  async list(): Promise<RouteJob[]> {
    const stored = this.#store.listIds()
      .map((id) => this.#store.getStored(id))
      .filter((job): job is NonNullable<typeof job> => job !== null);
    const currentId = await this.#dependencies.currentInstallationId().catch(() => null);
    return stored.flatMap(({ id, plan }) => {
      const job = this.#store.toPublic(id, !plan.installationId || currentId !== plan.installationId || plan.accessPolicyVersion !== ACCESS_ENTRY_POLICY_VERSION);
      return job ? [job] : [];
    });
  }

  async get(id: string): Promise<RouteJob | null> {
    const stored = this.#store.getStored(id);
    if (!stored) return null;
    const currentId = await this.#dependencies.currentInstallationId().catch(() => null);
    return this.#store.toPublic(id, !stored.plan.installationId || currentId !== stored.plan.installationId || stored.plan.accessPolicyVersion !== ACCESS_ENTRY_POLICY_VERSION);
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
    await this.#dependencies.cleanupInstallations?.();
  }

  async results(id: string, cursorText?: string): Promise<RouteJobResultsPage> {
    const current = await this.get(id);
    // Refresh after the asynchronous installation lookup so progress and rows
    // describe the same durable checkpoint, including during an active search.
    const job = current && this.#store.toPublic(id, current.stale);
    if (!job) throw new ServerApiError("ROUTE_JOB_NOT_FOUND", "That batch route job was not found.", 404);
    if (job.status === "deleting") {
      throw new ServerApiError("ROUTE_JOB_RESULTS_NOT_READY", "This job is being deleted.", 409);
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
        if (!job.plan.installationId) {
          this.#store.finish(job.id, "cancelled", "This saved search uses legacy data. Install prepared coverage and restart the search; saved results remain available.");
          continue;
        }
        if (job.plan.accessPolicyVersion !== ACCESS_ENTRY_POLICY_VERSION) {
          this.#store.finish(job.id, "cancelled", "This saved search uses an earlier starting-point policy. Rebuild coverage and start a new search; saved results remain available.");
          continue;
        }
        await this.#dependencies.pinInstallation(job.plan.installationId, () => this.#runJob(job, controller.signal));
        this.#store.finish(job.id, "completed");
      } catch (error) {
        this.#store.finish(job.id, controller.signal.aborted || isCancellationError(error) ? "cancelled" : "failed", errorMessage(error));
      } finally {
        this.#active = undefined;
        await this.#dependencies.cleanupInstallations?.();
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

      type Point = NonNullable<ReturnType<SQLiteRouteJobStore["nextAccessPoint"]>>;
      type Outcome = { searched: Awaited<ReturnType<typeof session.searchAccessPoint>> } | { error: unknown };
      type Task = { point: Point; outcome?: Outcome };
      const concurrency = Math.max(1, Math.min(8, Math.floor(session.concurrency ?? 1)));
      const pending: Task[] = [];
      const running = new Map<number, Promise<{ task: Task; outcome: Outcome }>>();
      const checkControl = () => {
        if (signal.aborted) throw signal.reason;
        const latest = this.#store.getControl(id);
        if (!latest || latest.cancelRequested || latest.deleteRequested) throw new DOMException("Cancelled", "AbortError");
      };
      for (;;) {
        checkControl();
        // Keep workers busy across uneven starts, with at most two worker waves
        // retained behind a slow checkpoint. Every uncommitted start is reset
        // to pending on restart, so completed later starts cannot skip a gap.
        while (running.size < concurrency && pending.length < concurrency * 2) {
          const point = this.#store.nextAccessPoint(id);
          if (!point) break;
          const task: Task = { point };
          pending.push(task);
          running.set(point.ordinal, session.searchAccessPoint(point.accessPointId, signal, point.attempt)
            .then((searched) => ({ task, outcome: { searched } }), (error: unknown) => ({ task, outcome: { error } })));
        }
        if (running.size === 0) {
          if (this.#store.beginNextPass(id)) continue;
          break;
        }
        const completed = await Promise.race(running.values());
        running.delete(completed.task.point.ordinal);
        completed.task.outcome = completed.outcome;
        checkControl();
        // Commit in access ordinal order, including failures. Geometry dedup
        // then chooses the same owner regardless of child completion order.
        for (;;) {
          const task = pending[0];
          if (!task?.outcome) break;
          checkControl();
          pending.shift();
          const { point, outcome } = task;
          if ("error" in outcome) {
            if (isCancellationError(outcome.error)) throw outcome.error;
            this.#store.failAccessPoint(id, point.ordinal, errorMessage(outcome.error), point.attempt);
          } else {
            const { searched } = outcome;
            const results: RouteJobResult[] = searched.exact.slice(0, 10).map((route) => ({
              matchType: "exact", accessPointId: point.accessPointId, route,
            }));
            if (results.length === 0 && searched.nearMisses[0]) results.push({
              matchType: "near-miss", accessPointId: point.accessPointId, route: searched.nearMisses[0],
            });
            const retained = retainBetterResults(this.#store.accessPointResults(id, point.ordinal), results, request.criteria);
            this.#store.completeAccessPoint(id, point.ordinal, retained, searched.truncated, searched.diagnostics, {
              attempt: point.attempt,
              // Older injected sessions did not report completion. Preserve
              // their one-pass behavior; only an explicit retryable outcome
              // admits another attempt.
              completion: searched.completion ?? (searched.truncated ? "limited" : "exhausted"),
            });
          }
          await yieldToEventLoop(signal);
        }
        await yieldToEventLoop(signal);
      }
    } finally {
      await session.close();
    }
  }
}
