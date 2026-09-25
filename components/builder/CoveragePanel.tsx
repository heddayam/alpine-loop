"use client";

import { useEffect, useRef } from "react";
import type { ReleaseSection } from "@/lib/contracts/releases";
import { areaBounds } from "@/lib/graph/geometry";
import type { CoverageOverlay } from "../map/HikeMap";
import { processingCoverage, useCoverage } from "./useCoverage";

const labels = { available: "Available", selected: "Selected", downloading: "Downloading", installed: "Installed" };
function bytes(value: number) { return value < 1024 * 1024 ? `${Math.round(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
export function sectionLabel(section: ReleaseSection) {
  const [w,s,e,n] = areaBounds(section.geometry), lat=(s+n)/2, lon=(w+e)/2;
  return `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? "W" : "E"}`;
}

export function CoveragePanel({ open, selected, onToggle, onChanged, onMapChange, onClose }: {
  open: boolean; selected: string[]; onToggle: (id: string) => void; onClose?: () => void;
  onChanged?: () => void; onMapChange?: (overlay: CoverageOverlay) => void;
}) {
  const resource = useCoverage(open);
  const { catalog, busy, error } = resource;
  const release = catalog?.release, installed = catalog?.installed;
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!catalog) return;
    const next = catalog.installed?.id ?? null;
    if (previous.current !== undefined && next !== previous.current) onChanged?.();
    previous.current = next;
  }, [catalog, onChanged]);
  const sections = release?.sections ?? [];
  const installedIds = new Set(installed?.sectionIds ?? []);
  const additionalCount = sections.filter(({ id }) => !installedIds.has(id)).length;
  const unavailableInstalled = [...installedIds].filter((id) => !sections.some((section) => section.id === id));
  const selectedIds = new Set(selected.filter((id) => sections.some((section) => section.id === id)));
  const desired = [...new Set([...installedIds, ...selectedIds])].sort();
  const removable = [...selectedIds].filter((id) => installedIds.has(id));
  const updating = Boolean(installed && release && installed.releaseId !== release.id);
  const downloadable = !unavailableInstalled.length && selectedIds.size > 0 && (updating || [...selectedIds].some((id) => !installedIds.has(id)));
  const request = release ? { releaseId: release.id, sectionIds: desired } : null;
  const plan = resource.plan && resource.plan.releaseId === release?.id && JSON.stringify([...resource.plan.sectionIds].sort()) === JSON.stringify(desired) ? resource.plan : undefined;
  const downloading = new Set(catalog?.jobs.filter(processingCoverage).flatMap((job) => job.sectionIds) ?? []);
  const mapKey = JSON.stringify({
    features: { type: "FeatureCollection", features: [...(installed && unavailableInstalled.length ? [{ type: "Feature", geometry: installed.geometry, properties: { status: "installed" } }] : []), ...sections.map((section) => ({ type: "Feature", id: section.id, geometry: section.geometry,
      properties: { sectionId: section.id, status: selectedIds.has(section.id) ? "selected" : downloading.has(section.id) ? "downloading" : installedIds.has(section.id) ? "installed" : "available" } }))] },
    focus: installed ? areaBounds(installed.geometry) : release ? areaBounds(release.geometry) : null,
  });
  useEffect(() => { onMapChange?.(JSON.parse(mapKey)); }, [mapKey, onMapChange]);
  const selectedArtifacts = new Set(sections.filter(({id}) => selectedIds.has(id)).flatMap(({artifactIds}) => artifactIds));
  const selectedBytes = release?.artifacts.filter(({id}) => selectedArtifacts.has(id)).reduce((sum, file) => sum + file.compressedBytes, 0) ?? 0;
  return <aside className="builder-panel coverage-panel" hidden={!open} aria-labelledby="coverage-title">
    <div className="builder-scroll coverage-content">
      {onClose ? <button type="button" className="btn-link" onClick={onClose}>← Back to planning</button> : null}
      <h2 id="coverage-title">Manage coverage</h2>
      <p>Download prepared hiking data. Managing coverage keeps your search area unchanged.</p>
      <p className="coverage-caveat">Mapped trails can be incomplete. Installed coverage does not confirm current access or trail conditions.</p>
      {error || catalog?.error ? <div role="alert" className="error-state">{error ?? catalog?.error} <button type="button" className="btn" disabled={busy} onClick={() => void resource.refresh()}>Retry</button></div> : null}
      {!catalog && !error ? <p role="status">Loading coverage…</p> : null}
      {release?.limitations.length ? <section className="coverage-caveat" aria-labelledby="coverage-limits"><h3 id="coverage-limits">Coverage limits</h3><ul>{release.limitations.map((text) => <li key={text}>{text}</li>)}</ul></section> : null}
      <ul className="coverage-legend" aria-label="Coverage map legend">{Object.entries(labels).map(([status,label]) => <li key={status}><span className={`coverage-swatch coverage-${status}`} />{label}</li>)}</ul>
      {catalog ? <>
        <p>{installed ? `${installed.sectionIds.length} ${installed.sectionIds.length === 1 ? "section" : "sections"} installed` : "No prepared coverage installed."}</p>
        {release ? <>
          <p role="status"><strong>{additionalCount ? `${additionalCount} additional ${additionalCount === 1 ? "section" : "sections"} available in this catalog.` : "No additional coverage is available in this catalog."}</strong></p>
          <p>{additionalCount ? "Click outlined available sections on the map or choose them from the list below, then select Preview download. Areas without sections are not published yet." : "All sections in this catalog are installed. Select installed sections on the map or in the list below to remove coverage."}</p>
          <p className="hint">Data release: {new Date(release.builtAt).toLocaleDateString(undefined, { timeZone: "UTC" })}</p>
          <details><summary>Sources and attribution</summary><ul>{release.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.authority} · {source.dataset}</a><small> {source.version} · {source.license}</small></li>)}</ul></details>
          <p role="status">{selectedIds.size} {selectedIds.size === 1 ? "section" : "sections"} selected · {bytes(selectedBytes)} packaged download</p>
          <div className="action-row">
            <button type="button" className="btn" disabled={busy || !downloadable} onClick={() => request && void resource.preview(request)}>Preview download</button>
            {removable.length ? <button type="button" className="btn" disabled={busy} onClick={() => void resource.remove(removable)}>Remove selected coverage</button> : null}
            {updating ? <button type="button" className="btn" disabled={busy || unavailableInstalled.length > 0} onClick={() => request && void resource.preview(request)}>Preview update</button> : null}
          </div>
          {unavailableInstalled.length ? <p className="hint">{unavailableInstalled.length} installed sections are unavailable in this catalog. Your existing coverage is retained. <button type="button" className="btn" disabled={busy} onClick={() => void resource.remove(unavailableInstalled)}>Remove unavailable sections</button></p> : null}
          {updating ? <p className="hint">An update replaces all installed sections together. Current coverage stays available until the update is ready.</p> : null}
          <details className="coverage-units"><summary>Select sections from a list</summary><fieldset disabled={busy}>{sections.map((section) => <label className="coverage-choice" key={section.id}><input type="checkbox" checked={selectedIds.has(section.id)} onChange={() => onToggle(section.id)} /><span>{sectionLabel(section)}{installedIds.has(section.id) ? <small>Installed</small> : null}</span></label>)}</fieldset></details>
        </> : !catalog.error ? <p>No download catalog is configured.</p> : null}
        {plan ? <section className="coverage-plan" aria-labelledby="download-preview"><h3 id="download-preview">Download preview</h3><dl>
          <div><dt>Download remaining</dt><dd>{bytes(plan.downloadBytes)}</dd></div>
          <div><dt>Installed data</dt><dd>{bytes(plan.installedBytes)}</dd></div>
          <div><dt>Additional disk required</dt><dd>{bytes(plan.additionalBytes)}</dd></div>
          <div><dt>Reusable data</dt><dd>{bytes(plan.reusableBytes)}</dd></div>
        </dl><button type="button" className="btn" disabled={busy} onClick={() => request && void resource.start(request)}>Download coverage</button></section> : null}
        <section aria-labelledby="coverage-downloads"><h3 id="coverage-downloads">Downloads</h3>{catalog.jobs.length ? catalog.jobs.map((job) => <article className="job-card" key={job.id} aria-label={`Download ${job.id}`}>
          <header><strong>{job.sectionIds.length} sections</strong><span className="job-status">{job.status}</span></header>
          <p role="status">{job.stage} · {bytes(job.downloadedBytes)} / {bytes(job.totalBytes)}</p>
          <progress value={job.downloadedBytes} max={Math.max(1,job.totalBytes)} aria-label="Download progress" />
          {job.error ? <p className="error-state">{job.error}</p> : null}
          <footer>{["queued","running"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"pause")}>Pause</button> : null}
          {["paused","failed"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"resume")}>Resume</button> : null}
          {processingCoverage(job) || ["paused","failed"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"cancel")}>Cancel download</button> : null}</footer>
        </article>) : <p>No downloads yet.</p>}</section>
      </> : null}
      {busy ? <p role="status">Updating coverage…</p> : null}
    </div>
  </aside>;
}
