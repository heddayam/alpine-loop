import { Fragment, useEffect, useRef, useState } from "react";
import type { JobRegion, JobSnapshot, SearchQuery } from "../model.js";
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

/** Use prepared geography, keeping unknown saved sections explicit. */
export function jobAreaSummary(job: JobSnapshot, catalog: JobRegion[] = []) {
  const groups = new Map<string, string>();
  for (const id of job.query.sections) {
    const saved = job.regions?.find(section => section.id === id)
      ?? job.inputs?.sections.find(section => section.id === id);
    const section = saved?.state && saved.regionId && saved.regionName
      ? saved : catalog.find(section => section.id === id) ?? saved;
    if (section?.state && section.regionId && section.regionName) {
      groups.set(`${section.state}/${section.regionId}`, `${section.state} ${section.regionName}`);
    } else {
      groups.set(id, section?.name ?? id);
    }
  }
  return [...groups.values()].join(", ");
}

export function JobsDialog({
  open,
  units = "imperial",
  jobs,
  regionName,
  catalogSections = [],
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
  catalogSections?: JobRegion[];
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
  const [expanded, setExpanded] = useState<string | null>(null);
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
          <h2 id="jobs-title">Jobs <span className="jobs-count">{jobs.length}{hasOlder || hasNewer ? " shown" : ""}</span></h2>
        </div>
        <button type="button" aria-label="Close jobs" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="jobs-list" ref={list}>
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
        {!!jobs.length && <table className="jobs-table" aria-label="Search jobs">
          <colgroup>
            <col className="jobs-expand-col" /><col className="jobs-area-col" />
            <col className="jobs-distance-col" /><col className="jobs-gain-col" />
            <col className="jobs-stem-col" /><col className="jobs-roads-col" />
            <col className="jobs-status-col" /><col className="jobs-results-col" />
            <col className="jobs-duration-col" /><col className="jobs-created-col" />
            <col className="jobs-actions-col" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Details</span></th>
              <th scope="col">Search area</th>
              <th scope="col" className="job-number">Distance <span className="job-unit">{display.distanceLabel}</span></th>
              <th scope="col" className="job-number">Gain <span className="job-unit">{display.elevationLabel}</span></th>
              <th scope="col" className="job-number">Max stem</th>
              <th scope="col" className="job-number">Max roads</th>
              <th scope="col" className="job-group-start">Status</th>
              <th scope="col" className="job-number">Hikes</th>
              <th scope="col" className="job-number">Duration</th>
              <th scope="col">Created</th>
              <th scope="col" className="job-group-start">Actions</th>
            </tr>
          </thead>
          <tbody>
          {jobs.map((job) => {
            const busy = pending?.id === job.id;
            const roads = job.query.roads ?? DEFAULT_ROAD_LIMITS;
            const title = jobTitle(job, regionName);
            const areas = job.query.sections.map((id) => jobRegionName(job, id, regionName));
            const areaSummary = jobAreaSummary(job, catalogSections);
            const isExpanded = expanded === job.id;
            const percentage = job.progress.totalSearchPoints
              ? Math.floor(100 * (job.progress.completedSearchPoints ?? 0) / job.progress.totalSearchPoints)
              : null;
            const status = job.status[0]!.toUpperCase() + job.status.slice(1);
            return (
              <Fragment key={job.id}>
                <tr
                  id={`job-card-${job.id}`}
                  className={`job-row${highlightedId === job.id ? " highlighted" : ""}${isExpanded ? " expanded" : ""}`}
                  aria-busy={busy || undefined}
                  onClick={(event) => {
                    if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea")) return;
                    setExpanded(isExpanded ? null : job.id);
                  }}
                >
                  <td className="job-expand-cell">
                    <button type="button" className="job-icon-button job-expand" aria-label={`Details for ${title}`}
                      aria-expanded={isExpanded} aria-controls={`job-details-${job.id}`}
                      onClick={() => setExpanded(isExpanded ? null : job.id)}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
                    </button>
                  </td>
                  <th scope="row" className="job-area">
                    <div className="job-area-line" title={areas.join(", ")}>
                      <span>{job.query.boundary ? `Drawn area · ${areaSummary}` : areas.length > 1 ? areaSummary : areas[0]}</span>
                      {areas.length > 1 && <span className="job-area-count">{areas.length} sections</span>}
                    </div>

                  </th>
                  <td className="job-number">{Number(distanceText(job.query.distance[0], units))}–{Number(distanceText(job.query.distance[1], units))}</td>
                  <td className="job-number">{elevationText(job.query.gain[0], units)}–{elevationText(job.query.gain[1], units)}</td>
                  <td className="job-number job-limit">
                    <span>{Number(distanceText(stemLimit(job.query), units, 3))} {display.distanceLabel}</span>
                    <span className="job-muted">{job.query.repetition !== undefined ? `${Number((job.query.repetition * 100).toFixed(1))}%` : "—"}</span>
                  </td>
                  <td className="job-number job-limit">
                    <span>{Number(distanceText(roads.distance, units, 3))} {display.distanceLabel}</span>
                    <span className="job-muted">{Number((roads.fraction * 100).toFixed(1))}%</span>
                  </td>
                  <td className="job-group-start">
                    <span className={`job-status status-${job.status}`}>
                      <span className="job-status-dot" aria-hidden="true" />
                      {busy ? pending.action === "cancel" ? "Cancelling…" : pending.action === "delete" ? "Deleting…" : "Opening…" : status}
                    </span>
                    {job.status === "running" && percentage !== null && <span className="job-status-progress">{percentage}%</span>}
                  </td>
                  <td className="job-number">
                    {hasSavedResults(job) ? job.groupCount?.toLocaleString() ?? "—" : <span className="job-muted">—</span>}
                  </td>
                  <td className="job-number">{job.status === "queued" ? "—" : elapsed(job.progress.elapsedMs)}</td>

                  <td><time className="job-created" dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString()}>
                    {new Date(job.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    {", "}{new Date(job.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </time></td>
                  <td className="job-group-start"><div className="job-actions">
                    {hasSavedResults(job) && <button type="button" className="job-results" disabled={busy} onClick={() => onView(job)}>View results</button>}
                    <div className="job-secondary-actions">
                    <button type="button" className="job-icon-button" aria-label="Copy settings" title="Copy settings" disabled={busy} onClick={() => onCopy(job)}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1" /><path d="M3 11H2V2h8v1" /></svg>
                    </button>
                    {activeJob(job)
                      ? <button type="button" className="job-cancel" disabled={busy} onClick={() => onAction(job, "cancel")}>Cancel</button>
                      : <button type="button" id={`job-delete-${job.id}`} className="job-icon-button" aria-label="Delete" title="Delete job" disabled={busy} onClick={() => setConfirmDelete(job.id)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 6v5M9 6v5" /></svg>
                      </button>}
                    </div>
                  </div></td>
                </tr>
                <tr id={`job-details-${job.id}`} className="job-detail-row" hidden={!isExpanded}>
                  <td colSpan={11}>
                    <div className="job-detail-content">
                      <div>
                        <h3>Search settings</h3>
                        <p>{areas.join(", ")}</p>
                        {job.query.boundary && <p>Starting points inside the boundary; hikes may extend outside.</p>}
                        <p>Stem up to {Number(distanceText(stemLimit(job.query), units, 3))} {display.distanceLabel}{job.query.repetition !== undefined && ` and ${Number((job.query.repetition * 100).toFixed(1))}%`}; roads up to {Number(distanceText(roads.distance, units, 3))} {display.distanceLabel} and {Number((roads.fraction * 100).toFixed(1))}%.</p>
                        {job.query.grades && (["uphill", "downhill"] as const).map(direction => {
                          const limit = job.query.grades![direction];
                          return <p key={direction}>{direction === "uphill" ? "Uphill" : "Downhill"} above {limit.above}%: {Number(distanceText(limit.total, units, 3))} {display.distanceLabel} total, {Number(distanceText(limit.longest, units, 3))} {display.distanceLabel} longest stretch.</p>;
                        })}
                      </div>
                      <div>
                        <h3>{job.status === "running" || job.status === "queued" ? "Progress" : "Outcome"}</h3>
                        {job.status === "running" && <div className="job-search-progress">
                          <p>{job.progress.stage === "preparing" ? "Preparing trail data" : job.progress.stage === "saving" ? "Saving results" : `Searching ${job.progress.currentRegion?.name ?? "trails"}`}</p>
                          <progress aria-label="Within-region search progress" max={job.progress.totalSearchPoints || undefined} value={job.progress.totalSearchPoints ? (job.progress.completedSearchPoints ?? 0) : undefined} />
                          <p>{job.progress.completedRegions.length} of {job.progress.totalRegions} regions finished</p>
                        </div>}
                        {job.status === "queued" && <p>Queue position {job.queuePosition ?? "—"}</p>}
                        {job.reason && <p className="job-error">{job.reason}</p>}
                        {job.status === "interrupted" && <p>Server stopped. Copy settings to try again.</p>}
                        {["cancelled", "failed", "interrupted"].includes(job.status) && <p>Unfinished results were discarded.</p>}
                        {hasSavedResults(job) && <p>{job.groupCount === 0 ? "No qualifying hikes were found by this search." : `${job.groupCount?.toLocaleString() ?? "Saved"} hikes available.`}</p>}
                        <p className="job-muted">Storage: {storage(job.storageBytes)} · Job {job.id}</p>
                      </div>
                    </div>
                  </td>
                </tr>
                {confirmDelete === job.id && <tr className="job-delete-row">
                  <td colSpan={11}>
                    <div className="delete-confirm" role="alert">
                      <p>Delete “{title}” and its saved results?</p>
                      <button type="button" disabled={busy} onClick={() => { onAction(job, "delete"); setConfirmDelete(null); }}>Delete job</button>
                      <button type="button" autoFocus disabled={busy} onClick={() => { setConfirmDelete(null); document.getElementById(`job-delete-${job.id}`)?.focus(); }}>Keep job</button>
                    </div>
                  </td>
                </tr>}
              </Fragment>
            );
          })}
          </tbody>
        </table>}
      </div>
      <footer className="jobs-storage">
        <span>{jobs.length} jobs{hasOlder || hasNewer ? " on this page" : ""} · {storage(jobs.reduce((bytes, job) => bytes + job.storageBytes, 0))}</span>
        {(hasNewer || hasOlder) && <nav aria-label="Job history pages">
          <button type="button" disabled={loading || !hasNewer} onClick={onNewer}>Newer jobs</button>
          <button type="button" disabled={loading || !hasOlder} onClick={onOlder}>Older jobs</button>
        </nav>}
      </footer>
    </dialog>
  );
}
