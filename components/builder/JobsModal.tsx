"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  routeJobResultsPageSchema,
  type RouteJob,
  type RouteJobResultsPage,
} from "@/lib/contracts";

export type JobsLoadState = "loading" | "ready" | "error";
type PendingAction = "cancelling" | "deleting" | "opening";

const ACTIVE_STATUSES = new Set<RouteJob["status"]>(["queued", "resolving-drive-time", "running"]);
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
  if (pending === "cancelling") return "Stopping after the current trailhead; completed routes will be kept.";
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
}: {
  open: boolean;
  jobs: RouteJob[];
  loadState: JobsLoadState;
  loadError?: string;
  refreshedAt?: number;
  onClose: () => void;
  onRefresh: (abortStale?: boolean) => Promise<void>;
  onOpenResults: (page: RouteJobResultsPage) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const resultsControllerRef = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  const mountedRef = useRef(true);
  const [feedback, setFeedback] = useState<{ kind: "status" | "error"; text: string }>();
  const [pendingByJob, setPendingByJob] = useState<Record<string, PendingAction>>({});
  const [now, setNow] = useState(() => Date.now());

  const close = useCallback(() => {
    openRef.current = false;
    resultsControllerRef.current?.abort();
    onClose();
  }, [onClose]);

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
    openRef.current = open;
    if (!open) resultsControllerRef.current?.abort();
    return () => { if (!open) resultsControllerRef.current?.abort(); };
  }, [open]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openRef.current = false;
      resultsControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!open || !jobs.some((job) => ACTIVE_STATUSES.has(job.status) || job.status === "deleting")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [jobs, open]);

  if (!open) return null;

  const mutate = async (job: RouteJob, action: "cancel" | "delete") => {
    const pending: PendingAction = action === "cancel" ? "cancelling" : "deleting";
    setPendingByJob((current) => ({ ...current, [job.id]: pending }));
    setFeedback({
      kind: "status",
      text: action === "cancel"
        ? "Cancellation requested. Completed routes will be kept."
        : "Deletion requested. The job will disappear when removal finishes.",
    });
    try {
      const response = await fetch(`/api/route-jobs/${job.id}${action === "cancel" ? "/cancel" : ""}`, {
        method: action === "cancel" ? "POST" : "DELETE",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Job could not be ${action === "cancel" ? "cancelled" : "deleted"}.`);
      await onRefresh(true);
    } catch (error) {
      setPendingByJob((current) => { const next = { ...current }; delete next[job.id]; return next; });
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The job could not be updated." });
    }
  };

  const loadResults = async (job: RouteJob) => {
    resultsControllerRef.current?.abort();
    const controller = new AbortController();
    resultsControllerRef.current = controller;
    setPendingByJob((current) => ({ ...current, [job.id]: "opening" }));
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/route-jobs/${job.id}/results?limit=50`, { cache: "no-store", signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted || resultsControllerRef.current !== controller || !openRef.current) return;
      if (!response.ok) throw new Error("Job results could not be loaded.");
      onOpenResults(routeJobResultsPageSchema.parse(payload));
    } catch (error) {
      if (!controller.signal.aborted && resultsControllerRef.current === controller && openRef.current) setFeedback({ kind: "error", text: error instanceof Error ? error.message : "Job results could not be loaded." });
    } finally {
      if (resultsControllerRef.current === controller) resultsControllerRef.current = null;
      if (mountedRef.current) setPendingByJob((current) => { const next = { ...current }; delete next[job.id]; return next; });
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} className="settings-modal jobs-modal" role="dialog" aria-modal="true" aria-labelledby="jobs-title" aria-describedby="jobs-description">
        <header className="settings-modal-heading">
          <h2 id="jobs-title">Jobs</h2>
          <button type="button" className="settings-close" aria-label="Close jobs" onClick={close}>×</button>
        </header>
        <div className="settings-modal-content jobs-list">
          <p id="jobs-description" className="hint">Saved on this device. Full searches resume after a restart; results stay until deleted.</p>
          {feedback ? <p className={feedback.kind === "error" ? "error-state" : "job-note"} role={feedback.kind === "error" ? "alert" : "status"} aria-live={feedback.kind === "status" ? "polite" : undefined}>{feedback.text}</p> : null}
          {loadState === "error" ? <div className="jobs-refresh-error" role="alert"><span>{loadError ?? "Progress may be out of date."}</span><button type="button" className="btn btn-danger" onClick={() => void onRefresh(true)}>Retry</button></div> : null}
          {loadState === "loading" && jobs.length === 0 ? <p className="loading-state" role="status">Loading saved jobs…</p> : null}
          {loadState !== "loading" && jobs.length === 0 ? <p className="empty-state" role="status">No batch searches yet.</p> : jobs.map((job) => {
            const progress = job.progress;
            const storedPending = pendingByJob[job.id];
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
                <header><div><strong id={titleId}>{job.searchRegion.name}</strong><small>{job.request.origin && job.request.durationMinutes
                  ? `${job.request.durationMinutes} min from ${job.request.origin.label}`
                  : "Entire reviewed region"}</small></div><span className={`job-status status-${pending ?? job.status}`}>{statusLabel}</span></header>
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
                {job.stale ? <p className="job-note">Built with an older pack version.</p> : null}
                {job.partial ? <p className="job-note">Partial results retained.</p> : null}
                {job.status === "cancelled" && !job.partial && progress.exactRouteCount + progress.nearMissRouteCount === 0 ? <p className="job-note">No routes were saved before cancellation.</p> : null}
                {job.error ? <p className="error-state">{job.error}</p> : null}
                <footer>
                  {canOpen ? <button type="button" className="btn" disabled={busy} aria-label={`View results for ${job.searchRegion.name}`} onClick={() => void loadResults(job)}>{pending === "opening" ? "Opening…" : "View results"}</button> : null}
                  {canCancel ? <button type="button" className="btn" disabled={busy} aria-label={`Cancel ${job.searchRegion.name} search`} onClick={() => void mutate(job, "cancel")}>Cancel</button> : null}
                  {pending === "cancelling" ? <button type="button" className="btn" disabled>Cancelling…</button> : null}
                  <button type="button" className="btn btn-danger" disabled={busy || job.status === "deleting"} aria-label={`Delete ${job.searchRegion.name} job and saved routes`} onClick={() => void mutate(job, "delete")}>{pending === "deleting" || job.status === "deleting" ? "Deleting…" : "Delete"}</button>
                </footer>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
