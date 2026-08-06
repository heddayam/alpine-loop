"use client";

import { useEffect, useRef, useState } from "react";
import {
  routeJobListSchema,
  routeJobResultsPageSchema,
  type RouteJob,
  type RouteJobResultsPage,
} from "@/lib/contracts";

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
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function JobsModal({
  open,
  jobs,
  onClose,
  onJobsChange,
  onOpenResults,
}: {
  open: boolean;
  jobs: RouteJob[];
  onClose: () => void;
  onJobsChange: (jobs: RouteJob[]) => void;
  onOpenResults: (page: RouteJobResultsPage) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [message, setMessage] = useState("");
  const [loadingJobId, setLoadingJobId] = useState<string>();

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
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
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/route-jobs", { cache: "no-store" });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error("Jobs could not be refreshed.");
        const parsed = routeJobListSchema.parse(payload);
        if (active) { onJobsChange(parsed.jobs); setMessage(""); }
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : "Jobs could not be refreshed.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [onJobsChange, open]);

  if (!open) return null;

  const mutate = async (job: RouteJob, action: "cancel" | "delete") => {
    setLoadingJobId(job.id);
    setMessage("");
    try {
      const response = await fetch(`/api/route-jobs/${job.id}${action === "cancel" ? "/cancel" : ""}`, {
        method: action === "cancel" ? "POST" : "DELETE",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Job could not be ${action === "cancel" ? "cancelled" : "deleted"}.`);
      if (action === "delete") onJobsChange(jobs.filter(({ id }) => id !== job.id));
      else {
        const updated = payload && typeof payload === "object" && "job" in payload ? payload.job : payload;
        onJobsChange(jobs.map((item) => item.id === job.id ? updated as RouteJob : item));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The job could not be updated.");
    } finally { setLoadingJobId(undefined); }
  };

  const loadResults = async (job: RouteJob) => {
    setLoadingJobId(job.id);
    setMessage("");
    try {
      const response = await fetch(`/api/route-jobs/${job.id}/results?limit=50`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("Job results could not be loaded.");
      onOpenResults(routeJobResultsPageSchema.parse(payload));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Job results could not be loaded.");
    } finally { setLoadingJobId(undefined); }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="settings-modal jobs-modal" role="dialog" aria-modal="true" aria-labelledby="jobs-title" aria-describedby="jobs-description">
        <header className="settings-modal-heading">
          <div><span className="eyebrow">Background route searches</span><h2 id="jobs-title">Jobs</h2></div>
          <button type="button" className="settings-close" aria-label="Close jobs" onClick={onClose}>×</button>
        </header>
        <div className="settings-modal-content jobs-list">
          <p id="jobs-description" className="settings-intro">Batch searches keep running while you explore. Open completed or cancelled jobs to inspect saved results.</p>
          {message ? <p className="error-state" role="alert">{message}</p> : null}
          {jobs.length === 0 ? <p className="empty-state" role="status">No batch searches yet.</p> : jobs.map((job) => {
            const progress = job.progress;
            const canOpen = job.status === "completed" || (job.status === "cancelled" && (progress.exactRouteCount + progress.nearMissRouteCount) > 0);
            const canCancel = ["queued", "resolving-drive-time", "running"].includes(job.status);
            const percent = progress.eligibleAccessPointCount > 0 ? Math.min(100, Math.round(progress.processedAccessPointCount / progress.eligibleAccessPointCount * 100)) : 0;
            return (
              <article className="job-card" key={job.id} aria-label={`${job.searchRegion.name} ${STATUS_LABELS[job.status]}`}>
                <header><div><strong>{job.searchRegion.name}</strong><small>{job.request.durationMinutes} min from {job.request.origin.label}</small></div><span className={`job-status status-${job.status}`}>{STATUS_LABELS[job.status]}</span></header>
                <progress max="100" value={percent} aria-label={`${percent}% complete`} />
                <dl>
                  <div><dt>Trailheads</dt><dd>{progress.processedAccessPointCount}/{progress.eligibleAccessPointCount || "—"}</dd></div>
                  <div><dt>Exact</dt><dd>{progress.exactRouteCount}</dd></div>
                  <div><dt>Near miss</dt><dd>{progress.nearMissRouteCount}</dd></div>
                  <div><dt>Truncated</dt><dd>{progress.truncatedAccessPointCount}</dd></div>
                  <div><dt>Elapsed</dt><dd>{elapsed(progress.elapsedMs)}</dd></div>
                </dl>
                {job.stale ? <p className="job-note">Built with an older pack version.</p> : null}
                {job.partial ? <p className="job-note">Partial results retained.</p> : null}
                {job.error ? <p className="error-state">{job.error}</p> : null}
                <footer>
                  {canOpen ? <button type="button" disabled={loadingJobId === job.id} onClick={() => void loadResults(job)}>View results</button> : null}
                  {canCancel ? <button type="button" disabled={loadingJobId === job.id} onClick={() => void mutate(job, "cancel")}>Cancel</button> : null}
                  <button type="button" className="danger-button" disabled={loadingJobId === job.id || job.status === "deleting"} onClick={() => void mutate(job, "delete")}>Delete</button>
                </footer>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
