"use client";

import { useEffect, useRef } from "react";
import { areaBounds } from "@/lib/graph/geometry";
import type { CoverageOverlay } from "../map/HikeMap";
import { processingCoverage, useCoverage } from "./useCoverage";

function bytes(value: number) { return value < 1024 * 1024 ? `${Math.round(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }

export function CoveragePanel({ open, selected, onChanged, onMapChange, onClose }: {
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
    focus: release ? areaBounds(release.geometry) : installed ? areaBounds(installed.geometry) : null,
  });
  useEffect(() => { onMapChange?.(JSON.parse(mapKey)); }, [mapKey, onMapChange]);
  const selectedArtifacts = new Set(sections.filter(({id}) => selectedIds.has(id)).flatMap(({artifactIds}) => artifactIds));
  const selectedBytes = release?.artifacts.filter(({id}) => selectedArtifacts.has(id)).reduce((sum, file) => sum + file.compressedBytes, 0) ?? 0;
  const activeJobs = catalog?.jobs.filter((job) => processingCoverage(job) || ["paused", "failed"].includes(job.status)) ?? [];
  const limited = release?.limitations.some((text) => /partial|benchmark|limited coverage/i.test(text));
  return <aside className="builder-panel coverage-panel" hidden={!open} aria-labelledby="coverage-title">
    <div className="builder-scroll coverage-content">
      {onClose ? <button type="button" className="btn-link" onClick={onClose}>← Back to planning</button> : null}
      <header className="coverage-heading"><h2 id="coverage-title">Manage coverage</h2>{limited ? <span className="coverage-limited">Limited coverage</span> : null}</header>
      {error || catalog?.error ? <div role="alert" className="error-state">{error ?? catalog?.error} <button type="button" className="btn" disabled={busy} onClick={() => void resource.refresh()}>Retry</button></div> : null}
      {!catalog && !error ? <span role="status">Loading coverage…</span> : null}
      {catalog ? <>
        <div className="coverage-counts" role="status"><span><i className="coverage-swatch coverage-available" />{additionalCount} available</span><span><i className="coverage-swatch coverage-installed" />{installedIds.size} installed</span></div>
        {release ? <>
          <div className="coverage-selection" role="status">{selectedIds.size} {selectedIds.size === 1 ? "section" : "sections"} selected · {bytes(selectedBytes)}</div>
          <div className="action-row">
            <button type="button" className="btn" disabled={busy || !downloadable} onClick={() => request && void resource.preview(request)}>Preview download</button>
            {removable.length ? <button type="button" className="btn" disabled={busy} onClick={() => void resource.remove(removable)}>Remove selected coverage</button> : null}
            {updating ? <button type="button" className="btn" disabled={busy || unavailableInstalled.length > 0} onClick={() => request && void resource.preview(request)}>Preview update</button> : null}
            {unavailableInstalled.length ? <button type="button" className="btn" disabled={busy} onClick={() => void resource.remove(unavailableInstalled)}>Remove unavailable sections ({unavailableInstalled.length})</button> : null}
          </div>
        </> : !catalog.error ? <span>No catalog configured</span> : null}
        {plan ? <section className="coverage-plan" aria-labelledby="download-preview"><h3 id="download-preview">Download preview</h3><dl>
          <div><dt>Download remaining</dt><dd>{bytes(plan.downloadBytes)}</dd></div>
          <div><dt>Additional disk required</dt><dd>{bytes(plan.additionalBytes)}</dd></div>
        </dl><button type="button" className="btn" disabled={busy} onClick={() => request && void resource.start(request)}>Download coverage</button></section> : null}
        {activeJobs.length ? <section className="coverage-downloads" aria-label="Active downloads">{activeJobs.map((job) => <article key={job.id} className="coverage-download" aria-label={`Download ${job.id}`}>
          <header><strong>{job.sectionIds.length} {job.sectionIds.length === 1 ? "section" : "sections"}</strong><span>{job.status}</span></header>
          <div role="status">{bytes(job.downloadedBytes)} / {bytes(job.totalBytes)}</div>
          <progress value={job.downloadedBytes} max={Math.max(1,job.totalBytes)} aria-label="Download progress" />
          {job.error ? <div className="error-state">{job.error}</div> : null}
          <footer className="action-row">{["queued","running"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"pause")}>Pause</button> : null}
          {["paused","failed"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"resume")}>Resume</button> : null}
          <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"cancel")}>Cancel download</button></footer>
        </article>)}</section> : null}
        {release ? <footer className="coverage-sources">{release.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.authority} · {source.license}</a>)}</footer> : null}
      </> : null}
      {busy ? <span role="status">Updating…</span> : null}
    </div>
  </aside>;
}
