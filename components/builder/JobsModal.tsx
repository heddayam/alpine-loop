"use client";

import { useEffect, useRef, useState } from "react";
import type { RouteJobV2 as RouteJob } from "@/lib/contracts/search";
import { ACTIVE_JOB_STATUSES as ACTIVE_STATUSES, type JobAction } from "./useJobs";

export type JobsLoadState = "loading" | "ready" | "error";
type PendingAction = JobAction | "opening";

const STATUS_LABELS: Record<RouteJob["status"], string> = {
  queued: "Queued",
  "resolving-drive-time": "Resolving drive time",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  deleting: "Deleting",
};

function elapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stage(job: RouteJob, pending?: PendingAction) {
  const { processedAccessPointCount: processed, eligibleAccessPointCount: eligible } = job.progress;
  if (pending === "cancelling") return "Stopping the search. Completed routes will be kept.";
  if (pending === "deleting" || job.status === "deleting") return "Removing this job and its saved routes.";
  switch (job.status) {
    case "queued": return "Waiting in queue.";
    case "resolving-drive-time": return "Calculating the drive-time area.";
    case "running": return eligible ? `Searching trailheads — ${processed} of ${eligible} attempted.` : "Finding eligible trailheads.";
    case "completed": return "All eligible trailheads were attempted.";
    case "cancelled": return eligible ? `Stopped after ${processed} of ${eligible} trailheads.` : "Search stopped before trailhead processing began.";
    case "failed": return "Stopped with an error.";
  }
}

function displayedElapsed(job: RouteJob, now: number, refreshedAt?: number) {
  if (!ACTIVE_STATUSES.has(job.status) && job.status !== "deleting") return job.progress.elapsedMs;
  return job.progress.elapsedMs + Math.max(0, refreshedAt ? now - refreshedAt : 0);
}

export function JobsModal({
  open,
  jobs,
  loadState,
  loadError,
  refreshedAt,
  onClose,
  onRefresh,
  onOpenResults,
  onMutate,
  pendingByJob,
  openingJobId,
}: {
  open: boolean;
  jobs: RouteJob[];
  loadState: JobsLoadState;
  loadError?: string;
  refreshedAt?: number;
  onClose: () => void;
  onRefresh: (abortStale?: boolean) => Promise<void>;
  onOpenResults: (id: string) => void;
  onMutate: (id: string, action: "cancel" | "delete") => void;
  pendingByJob: Record<string, JobAction>;
  openingJobId?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const close = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocusRef.current?.focus(); };
  }, [close, open]);

  useEffect(() => {
    if (!open || !jobs.some((job) => ACTIVE_STATUSES.has(job.status) || job.status === "deleting")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [jobs, open]);

  if (!open) return null;

  return (
    <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} className="settings-modal jobs-modal" role="dialog" aria-modal="true" aria-labelledby="jobs-title" aria-describedby="jobs-description">
        <header className="settings-modal-heading">
          <h2 id="jobs-title">Jobs</h2>
          <button type="button" className="settings-close" aria-label="Close jobs" onClick={close}>×</button>
        </header>
        <div className="settings-modal-content jobs-list">
          <p id="jobs-description" className="hint">Saved on this device. Full searches resume after a restart; results stay until deleted.</p>
          {loadError ? <div className="jobs-refresh-error" role="alert"><span>{loadError}</span><button type="button" className="btn btn-danger" onClick={() => void onRefresh(true)}>Retry</button></div> : null}
          {loadState === "loading" && jobs.length === 0 ? <p className="loading-state" role="status">Loading saved jobs…</p> : null}
          {loadState !== "loading" && jobs.length === 0 ? <p className="empty-state" role="status">No batch searches yet.</p> : jobs.map((job) => {
            const progress = job.progress;
            const storedPending = openingJobId === job.id ? "opening" : pendingByJob[job.id];
            const pending = storedPending === "cancelling" && !ACTIVE_STATUSES.has(job.status)
              ? undefined
              : storedPending;
            const canOpen = job.status === "completed" || (job.status === "cancelled" && (progress.exactRouteCount + progress.nearMissRouteCount) > 0);
            const canCancel = ACTIVE_STATUSES.has(job.status) && pending !== "cancelling";
            const determinate = progress.eligibleAccessPointCount > 0 || ["completed", "cancelled", "failed"].includes(job.status);
            const percent = progress.eligibleAccessPointCount > 0 ? Math.min(100, Math.round(progress.processedAccessPointCount / progress.eligibleAccessPointCount * 100)) : job.status === "completed" ? 100 : 0;
            const titleId = `job-${job.id}-title`;
            const stageId = `job-${job.id}-stage`;
            const statusLabel = pending === "cancelling" ? "Cancelling" : pending === "deleting" ? "Deleting" : STATUS_LABELS[job.status];
            const busy = Boolean(pending);
            return (
              <article className="job-card" key={job.id} aria-labelledby={titleId} aria-describedby={stageId} aria-busy={busy || undefined}>
                <header><div><strong id={titleId}>{job.area.label}</strong><small>{job.request.area.mode === "drive-time"
                  ? `${job.request.area.durationMinutes} min from ${job.request.area.origin.label}`
                  : job.request.area.mode === "drawn-area" ? "Drawn boundary" : "Named regions"}</small></div><span className={`job-status status-${pending ?? job.status}`}>{statusLabel}</span></header>
                <p className="job-stage" id={stageId}>{stage(job, pending)}</p>
                {determinate
                  ? <progress max="100" value={percent} aria-label={`${progress.processedAccessPointCount} of ${progress.eligibleAccessPointCount} trailheads attempted`} />
                  : <progress max="100" aria-label="Preparing trailhead search" />}
                <dl>
                  <div><dt>Trailheads</dt><dd>{progress.processedAccessPointCount}/{progress.eligibleAccessPointCount || "—"}</dd></div>
                  <div><dt>Exact</dt><dd>{progress.exactRouteCount}</dd></div>
                  <div><dt>Close matches</dt><dd>{progress.nearMissRouteCount}</dd></div>
                  <div><dt>Truncated</dt><dd>{progress.truncatedAccessPointCount}</dd></div>
                  <div><dt>Elapsed</dt><dd>{elapsed(displayedElapsed(job, now, refreshedAt))}</dd></div>
                </dl>
                {job.stale ? <p className="job-note">Generated with older map data.</p> : null}
                {job.partial ? <p className="job-note">Partial results retained.</p> : null}
                {job.status === "cancelled" && !job.partial && progress.exactRouteCount + progress.nearMissRouteCount === 0 ? <p className="job-note">No routes were saved before cancellation.</p> : null}
                {job.error ? <p className="error-state">{job.error}</p> : null}
                <footer>
                  {canOpen ? <button type="button" className="btn" disabled={busy} aria-label={`View results for ${job.area.label}`} onClick={() => onOpenResults(job.id)}>{pending === "opening" ? "Opening…" : "View results"}</button> : null}
                  {canCancel ? <button type="button" className="btn" disabled={busy} aria-label={`Cancel ${job.area.label} search`} onClick={() => onMutate(job.id, "cancel")}>Cancel</button> : null}
                  {pending === "cancelling" ? <button type="button" className="btn" disabled>Cancelling…</button> : null}
                  <button type="button" className="btn btn-danger" disabled={busy || job.status === "deleting"} aria-label={`Delete ${job.area.label} job and saved routes`} onClick={() => onMutate(job.id, "delete")}>{pending === "deleting" || job.status === "deleting" ? "Deleting…" : "Delete"}</button>
                </footer>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
