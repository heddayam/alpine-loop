import { useEffect, useRef, useState } from "react";
import { regionLabel } from "./RegionPicker.js";
import type { JobSnapshot, SearchQuery } from "../model.js";
import { DEFAULT_ROAD_LIMITS } from "../model.js";

const MILE = 1609.344,
  FOOT = 0.3048;
export const activeJob = (job: JobSnapshot) =>
  job.status === "queued" || job.status === "running";
export const hasSavedResults = (job: JobSnapshot) =>
  job.resultsRevision !== undefined || job.status === "completed";
export const savedResultsURL = (
  job: Pick<JobSnapshot, "id" | "resultsRevision">,
  path: string,
  query = "",
) => {
  const parameters = new URLSearchParams(query);
  parameters.set("revision", String(job.resultsRevision ?? 0));
  return `/api/jobs/${encodeURIComponent(job.id)}/${path}?${parameters}`;
};
export const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const storage = (bytes: number) =>
  bytes < 1_000_000
    ? `${(bytes / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
    : `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
export const requestSummary = (query: SearchQuery) =>
  `${(query.distance[0] / MILE).toLocaleString()}–${(query.distance[1] / MILE).toLocaleString()} mi · ${Math.round(query.gain[0] / FOOT).toLocaleString()}–${Math.round(query.gain[1] / FOOT).toLocaleString()} ft climb`;
export const jobRegionName = (
  job: JobSnapshot,
  id: string,
  regionName: (id: string) => string,
) =>
  regionLabel(
    job.regions?.find((region) => region.id === id)?.name ??
      job.inputs?.sections.find((section) => section.id === id)?.name ??
      regionName(id),
  );
export const jobTitle = (
  job: JobSnapshot,
  regionName: (id: string) => string,
) =>
  `${job.query.sections.map((id) => jobRegionName(job, id, regionName)).join(" · ")} · ${new Date(job.createdAt).toLocaleString()}`;

export function JobsDialog({
  open,
  jobs,
  regionName,
  highlightedId,
  error,
  pending,
  onClose,
  onRefresh,
  onView,
  onCopy,
  onAction,
  loading = false,
  hasOlder = false,
  hasNewer = false,
  onOlder,
  onNewer,
}: {
  open: boolean;
  jobs: JobSnapshot[];
  regionName: (id: string) => string;
  highlightedId: string | null;
  error: string;
  pending: { id: string; action: string } | null;
  onClose: () => void;
  onRefresh: () => void;
  onView: (job: JobSnapshot) => void;
  onCopy: (job: JobSnapshot) => void;
  onAction: (job: JobSnapshot, action: "cancel" | "delete") => void;
  loading?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
  onOlder?: () => void;
  onNewer?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
      else document.getElementById("open-search-jobs")?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open && highlightedId)
      document
        .getElementById(`job-card-${highlightedId}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedId, jobs.length]);
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [jobs[0]?.id]);
  return (
    <dialog
      ref={dialog}
      className="jobs-modal"
      aria-labelledby="jobs-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="jobs-heading">
        <div>
          <h2 id="jobs-title">Jobs</h2>
        </div>
        <button type="button" aria-label="Close jobs" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="jobs-list" ref={list}>
        {hasNewer && <button type="button" disabled={loading} onClick={() => { if (list.current) list.current.scrollTop = 0; onNewer?.(); }}>Newer jobs</button>}
        {loading && <p role="status">Loading jobs…</p>}
        {error && (
          <div className="job-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={onRefresh}>
              Retry
            </button>
          </div>
        )}
        {!jobs.length && !loading && <p className="empty-state">No jobs yet.</p>}
        {jobs.map((job) => {
          const busy = pending?.id === job.id;
          const roads = job.query.roads ?? DEFAULT_ROAD_LIMITS;
          const title = jobTitle(job, regionName);
          const status =
            job.status === "completed"
              ? "Ready"
              : job.status[0]!.toUpperCase() + job.status.slice(1);
          return (
            <article
              key={job.id}
              id={`job-card-${job.id}`}
              className={`job-card${highlightedId === job.id ? " highlighted" : ""}`}
              aria-busy={busy || undefined}
            >
              <header>
                <h3>
                  {job.query.sections
                    .map((id) => jobRegionName(job, id, regionName))
                    .join(" · ")}
                </h3>
                <span className={`job-status status-${job.status}`}>
                  {busy
                    ? pending.action === "cancel"
                      ? "Cancelling…"
                      : pending.action === "delete"
                        ? "Deleting…"
                        : "Opening…"
                    : status}
                </span>
              </header>
              <p className="job-created">
                {new Date(job.createdAt).toLocaleString()}
              </p>
              <p className="job-query">{requestSummary(job.query)}</p>
              <p className="job-limits">
                At most {job.query.repetition * 100}% walked again · roads{" "}
                {+(roads.distance / MILE).toFixed(3)} mi and{" "}
                {roads.fraction * 100}%<br />
                {job.query.includeUnknown
                  ? "Uncertain access included"
                  : "Uncertain access excluded"}
              </p>
              {job.status === "queued" ? (
                <p className="job-stage">
                  Queue position {job.queuePosition ?? "—"}
                </p>
              ) : job.status === "running" ? (
                <p className="job-stage" role="status">
                  {job.progress.stage === "preparing"
                    ? "Preparing trail data"
                    : job.progress.stage === "saving"
                      ? "Saving results"
                      : "Searching trails"}
                  {job.progress.currentRegion
                    ? ` · ${job.progress.currentRegion.name}`
                    : ""}{" "}
                  · {elapsed(job.progress.elapsedMs)} elapsed
                </p>
              ) : (
                <p className="job-stage">
                  {job.status === "completed"
                    ? `${job.groupCount?.toLocaleString() ?? "Saved"} ${job.groupCount === 1 ? "hike" : "hikes"} · `
                    : ""}
                  {elapsed(job.progress.elapsedMs)} elapsed
                </p>
              )}
              {job.status === "running" && (
                <div className="job-search-progress">
                  <div>
                    <span>Region search progress</span>
                    {!!job.progress.totalSearchPoints && (
                      <strong>
                        {Math.floor(
                          (100 * (job.progress.completedSearchPoints ?? 0)) /
                            job.progress.totalSearchPoints,
                        )}
                        %
                      </strong>
                    )}
                  </div>
                  <progress
                    aria-label="Within-region search progress"
                    max={job.progress.totalSearchPoints || undefined}
                    value={
                      job.progress.totalSearchPoints
                        ? (job.progress.completedSearchPoints ?? 0)
                        : undefined
                    }
                  />
                </div>
              )}
              {job.status !== "queued" && (
                <p className="job-regions">
                  {job.progress.completedRegions.length} of{" "}
                  {job.progress.totalRegions} regions completed
                </p>
              )}
              {job.reason && <p className="job-error">{job.reason}</p>}
              {job.status === "interrupted" && (
                <p className="job-note">
                  The server stopped during this job. Copy its settings to
                  submit it again.
                </p>
              )}
              {["cancelled", "failed", "interrupted"].includes(job.status) && (
                <p className="job-note">Unfinished results were discarded.</p>
              )}
              {hasSavedResults(job) && job.groupCount === 0 && (
                <p className="job-note">
                  No qualifying hikes were found by this search.
                </p>
              )}
              <footer>
                {hasSavedResults(job) && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => onView(job)}
                  >
                    View results
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onCopy(job)}
                >
                  Copy settings
                </button>
                {activeJob(job) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAction(job, "cancel")}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(job.id)}
                  >
                    Delete
                  </button>
                )}
              </footer>
              {confirmDelete === job.id && (
                <div className="delete-confirm" role="alert">
                  <p>Delete “{title}” and its saved results?</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onAction(job, "delete");
                      setConfirmDelete(null);
                    }}
                  >
                    Delete job
                  </button>
                  <button
                    type="button"
                    autoFocus
                    disabled={busy}
                    onClick={() => setConfirmDelete(null)}
                  >
                    Keep job
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {hasOlder && <button type="button" disabled={loading} onClick={() => { if (list.current) list.current.scrollTop = 0; onOlder?.(); }}>Older jobs</button>}
      </div>
      <footer className="jobs-storage">
        Shown jobs storage:{" "}
        {storage(jobs.reduce((bytes, job) => bytes + job.storageBytes, 0))}
      </footer>
    </dialog>
  );
}
