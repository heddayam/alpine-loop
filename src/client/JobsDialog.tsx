import { useEffect, useRef, useState } from "react";
import type { JobSnapshot, SearchQuery } from "../model.js";
import { DEFAULT_ROAD_LIMITS } from "../model.js";
import { distanceText, elevationText, stemLimit, unitsFor, type UnitSystem } from "./units.js";

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
export const requestSummary = (query: SearchQuery, units: UnitSystem = "imperial") => {
  const display = unitsFor(units);
  return `${distanceText(query.distance[0], units)}–${distanceText(query.distance[1], units)} ${display.distanceLabel}, ${elevationText(query.gain[0], units)}–${elevationText(query.gain[1], units)} ${display.elevationLabel} Elev. Gain`;
};
export const jobRegionName = (
  job: JobSnapshot,
  id: string,
  regionName: (id: string) => string,
) =>
  regionName(id) !== id ? regionName(id) :
    (job.regions?.find((region) => region.id === id)?.name ??
      job.inputs?.sections.find((section) => section.id === id)?.name ?? id);
export const jobTitle = (
  job: JobSnapshot,
  regionName: (id: string) => string,
) =>
  `${job.query.boundary ? "Drawn boundary; " : ""}${job.query.sections.map((id) => jobRegionName(job, id, regionName)).join(", ")}; ${new Date(job.createdAt).toLocaleString()}`;

export function JobsDialog({
  open,
  units = "imperial",
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
  units?: UnitSystem;
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
  const display = unitsFor(units);
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
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
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
                <div className="job-heading-text">
                <h3>
                  {job.query.boundary && "Drawn boundary: "}
                  {job.query.sections
                    .map((id) => jobRegionName(job, id, regionName))
                    .join(", ")}
                </h3>
                <time className="job-created" dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString()}>
                  {new Date(job.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  {", "}{new Date(job.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </time>
                </div>
                <span className={`job-status status-${job.status}`}>
                  {busy
                    ? pending.action === "cancel"
                      ? "Cancelling…"
                      : pending.action === "delete"
                        ? "Deleting…"
                        : "Opening…"
                    : status}
                  {job.status === "running" && !busy && ` ${elapsed(job.progress.elapsedMs)}`}
                </span>
              </header>
              <div className="job-specs">
                <p className="job-query">
                  <span>{Number(distanceText(job.query.distance[0], units))}–{Number(distanceText(job.query.distance[1], units))} {display.distanceLabel}</span>
                  <span>{elevationText(job.query.gain[0], units)}–{elevationText(job.query.gain[1], units)} {display.elevationLabel} gain</span>
                </p>
                <details className="job-details">
                  <summary>Constraints</summary>
                  <div>
                    {job.query.boundary && <p>Starting points inside the boundary; hikes may extend outside.</p>}
                    <p>Stem up to {Number(distanceText(stemLimit(job.query), units, 3))} {display.distanceLabel}{job.query.repetition !== undefined && ` and ${Number((job.query.repetition * 100).toFixed(1))}%`}; roads {Number(distanceText(roads.distance, units, 3))} {display.distanceLabel} and {Number((roads.fraction * 100).toFixed(1))}%.</p>
                  </div>
                </details>
              </div>
              {job.status === "running" && (
                <div className="job-search-progress">
                  <div>
                    <span>
                      {job.progress.stage === "preparing"
                        ? "Preparing trail data"
                        : job.progress.stage === "saving"
                          ? "Saving results"
                          : `Searching ${job.progress.currentRegion?.name ?? "trails"}`}
                    </span>
                    <span className="job-region-count">{job.progress.completedRegions.length} of {job.progress.totalRegions} regions finished</span>
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
              {job.reason && <p className="job-error">{job.reason}</p>}
              {job.status === "interrupted" && (
                <p className="job-note">
                  Server stopped. Copy settings to try again.
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
              {job.status === "queued" ? (
                <p className="job-stage">
                  Queue position {job.queuePosition ?? "—"}
                </p>
              ) : job.status !== "running" ? (
                <p className="job-stage">
                  {job.status === "completed"
                    ? `${job.groupCount?.toLocaleString() ?? "Saved"} ${job.groupCount === 1 ? "hike" : "hikes"}, `
                    : ""}
                  {elapsed(job.progress.elapsedMs)} elapsed
                </p>
              ) : null}
                <div className="job-actions">
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
                </div>
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
