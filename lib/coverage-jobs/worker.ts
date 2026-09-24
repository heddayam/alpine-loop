import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hasQueuedCoverageJobs, SQLiteCoverageJobStore } from "./store";
import { coverageJobDatabasePath, startCoverageWorker } from "./service";
import type { CoverageRuntime } from "./types";

/** A single process lease serializes every CLI and UI build on this installation. */
export async function runCoverageWorker(dbPath: string, runtime: Pick<CoverageRuntime, "run">): Promise<boolean> {
  const store = new SQLiteCoverageJobStore(dbPath);
  const token = randomUUID();
  if (!store.acquireLease(token, process.pid)) { store.close(); return false; }
  let normalExit = false;
  let activeAbort: AbortController | undefined;
  let activeJobId: string | undefined;
  let committing = false;
  const heartbeat = setInterval(() => {
    if (committing) return;
    try {
      if (!store.heartbeat(token)) activeAbort?.abort(new Error("Coverage writer lease lost"));
      if (activeJobId && ["pause", "cancel"].includes(store.checkpoint(activeJobId, token))) {
        activeAbort?.abort(new Error("Coverage build stopped by user"));
      }
    } catch (error) { activeAbort?.abort(error); }
  }, 1_000);
  heartbeat.unref();
  try {
    for (;;) {
      const job = store.claimNext(token);
      if (!job) break;
      activeJobId = job.id;
      activeAbort = new AbortController();
      try {
        const result = await runtime.run(job.plan, {
          signal: activeAbort.signal,
          publishOnly: job.mode === "publish",
          report: async (update) => { store.report(job.id, token, update); },
          checkpoint: async () => store.checkpoint(job.id, token),
          commitPublication: async (activate) => {
            committing = true;
            try { await store.commitPublication(job.id, token, activate); }
            finally { committing = false; }
          },
        });
        store.finish(job.id, token, result);
      } catch (error) {
        const control = store.checkpoint(job.id, token);
        if (control === "pause" || control === "cancel") store.finishStopped(job.id, token);
        else store.fail(job.id, token, error);
      } finally {
        activeJobId = undefined;
        activeAbort = undefined;
      }
    }
    normalExit = true;
  } finally {
    clearInterval(heartbeat);
    store.releaseLease(token);
    store.close();
    // A request may enqueue after the last empty-queue check but before release.
    if (normalExit && hasQueuedCoverageJobs(dbPath)) startCoverageWorker(dbPath);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error("Coverage worker requires a database path");
  if (coverageJobDatabasePath() !== dbPath) throw new Error("Coverage worker database differs from the configured installation");
  const runtime = await import("@/lib/coverage/runtime") as Pick<CoverageRuntime, "run">;
  process.send?.("coverage-worker-ready");
  await runCoverageWorker(dbPath, runtime);
}
