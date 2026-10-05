import { useEffect, useRef, useState } from "react";
import type { JobSnapshot, SearchQuery } from "../model.js";
import { DEFAULT_ROAD_LIMITS } from "../model.js";

const MILE = 1609.344,
  FOOT = 0.3048;
export const activeJob = (job: JobSnapshot) =>
  job.status === "queued" || job.status === "running";
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
  job.regions?.find((region) => region.id === id)?.name ??
  job.inputs?.sections.find((section) => section.id === id)?.name ??
  regionName(id);
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
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
      previous?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open && highlightedId)
      document
        .getElementById(`job-card-${highlightedId}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedId, jobs.length]);
  return (
    <dialog
      ref={dialog}
      className="jobs-modal"
      aria-labelledby="jobs-title"
      aria-describedby="jobs-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="jobs-heading">
        <div>
          <h2 id="jobs-title">Search jobs</h2>
          <p id="jobs-description">
            Saved on this computer until you delete them.
          </p>
        </div>
        <button type="button" aria-label="Close jobs" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="jobs-list">
        {error && (
          <div className="job-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={onRefresh}>
              Retry
            </button>
          </div>
        )}
        {!jobs.length && (
          <p className="empty-state">
            No search jobs yet. Submit a search to explore your selected
            regions.
          </p>
        )}
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
                  : "Mapped public access only"}
              </p>
              {job.status === "queued" ? (
                <p className="job-stage">
                  Queue position {job.queuePosition ?? "—"}. Runs after earlier
                  jobs.
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
              {job.status !== "queued" && (
                <p className="job-regions">
                  {job.progress.completedRegions.length} of{" "}
                  {job.progress.totalRegions} regions fully explored
                  {job.progress.completedRegions.length
                    ? `: ${job.progress.completedRegions.map((id) => jobRegionName(job, id, regionName)).join(" · ")}`
                    : ""}
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
              {job.status === "completed" && (
                <p className="job-note">
                  Saved results: {storage(job.storageBytes)}
                </p>
              )}
              <footer>
                {job.status === "completed" && (
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
      </div>
      <footer className="jobs-storage">
        Saved-results storage:{" "}
        {storage(jobs.reduce((bytes, job) => bytes + job.storageBytes, 0))}
      </footer>
    </dialog>
  );
}
