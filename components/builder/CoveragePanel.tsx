"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_ROUTE_DISTANCE_MILES } from "@/lib/contracts/routes";
import { areaBounds, type AreaGeometry } from "@/lib/graph/geometry";
import type { CoverageOverlay } from "../map/HikeMap";
import { processingCoverage, useCoverage } from "./useCoverage";

function bytes(value: number) { return value < 1024 * 1024 ? `${Math.round(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }

function combinedBounds(areas: readonly { geometry: AreaGeometry }[]): CoverageOverlay["focus"] {
  return areas.reduce<CoverageOverlay["focus"]>((union, { geometry }) => {
    const [w, s, e, n] = areaBounds(geometry);
    return union ? [Math.min(union[0], w), Math.min(union[1], s), Math.max(union[2], e), Math.max(union[3], n)] : [w, s, e, n];
  }, null);
}

export function CoveragePanel({ open, selected, onSelectionChange, onChanged, onMapChange, onClose, onShowArea }: {
  open: boolean; selected: string[]; onSelectionChange?: (ids: string[]) => void; onClose?: () => void;
  onChanged?: () => void; onShowArea?: () => void; onMapChange?: (overlay: CoverageOverlay) => void;
}) {
  const resource = useCoverage(open);
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState<Pick<CoverageOverlay, "focus" | "focusRevision">>();
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
  const unit = release?.partitioning === "local-areas" ? "area" : release?.partitioning === "connected-networks" ? "network" : "section";
  const namedList = Boolean(onSelectionChange || sections.some(section => section.name));
  const regionName = (section: typeof sections[number]) => section.name ?? `Area ${sections.indexOf(section) + 1}`;
  const visibleSections = sections.filter(section => regionName(section).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const installedIds = new Set(installed?.sectionIds ?? []);
  const additionalCount = sections.filter(({ id }) => !installedIds.has(id)).length;
  const unavailableInstalled = [...installedIds].filter((id) => !sections.some((section) => section.id === id));
  const selectedIds = new Set(selected.filter((id) => sections.some((section) => section.id === id)));
  const selectedSections = sections.filter(({ id }) => selectedIds.has(id));
  const desired = [...new Set([...installedIds, ...selectedIds])].sort();
  const removable = [...selectedIds].filter((id) => installedIds.has(id));
  const updating = Boolean(installed && release && installed.releaseId !== release.id);
  const downloadable = !unavailableInstalled.length && selectedIds.size > 0 && (updating || [...selectedIds].some((id) => !installedIds.has(id)));
  const request = release ? { releaseId: release.id, sectionIds: desired } : null;
  const downloading = new Set(catalog?.jobs.filter(processingCoverage).flatMap((job) => job.sectionIds) ?? []);
  const mapKey = JSON.stringify({
    features: { type: "FeatureCollection", features: [...(installed && unavailableInstalled.length ? [{ type: "Feature", geometry: installed.geometry, properties: { status: "installed" } }] : []), ...sections.map((section) => ({ type: "Feature", id: section.id, geometry: section.geometry,
      properties: { sectionId: section.id, status: selectedIds.has(section.id) ? "selected" : downloading.has(section.id) ? "downloading" : installedIds.has(section.id) ? "installed" : "available" } }))] },
    focus: release ? release.partitioning === "local-areas" ? combinedBounds(sections) : areaBounds(release.geometry) : installed ? areaBounds(installed.geometry) : null,
    ...focus,
  });
  useEffect(() => { onMapChange?.(JSON.parse(mapKey)); }, [mapKey, onMapChange]);
  const selectedArtifacts = new Set(sections.filter(({id}) => updating ? desired.includes(id) : selectedIds.has(id)).flatMap(({artifactIds}) => artifactIds));
  const selectedFiles = release?.artifacts.filter(({ id }) => selectedArtifacts.has(id)) ?? [];
  const selectedBytes = selectedFiles.filter(({ id }) => !installed?.artifactIds.includes(id)).reduce((sum, file) => sum + file.compressedBytes, 0);
  const installedBytes = selectedFiles.reduce((sum, file) => sum + file.bytes, 0);
  const showSelectedArea = () => {
    const bounds = combinedBounds(selectedSections);
    if (!bounds) return;
    setFocus({ focus: bounds, focusRevision: (focus?.focusRevision ?? 0) + 1 });
    onShowArea?.();
  };
  const activeJobs = catalog?.jobs.filter((job) => processingCoverage(job) || ["paused", "failed"].includes(job.status)) ?? [];
  return <aside className="builder-panel coverage-panel" hidden={!open} aria-labelledby="coverage-title">
    <div className="builder-scroll coverage-content">
      {onClose ? <button type="button" className="btn-link" onClick={onClose}>← Back to planning</button> : null}
      <header className="coverage-heading"><h2 id="coverage-title">Download trails</h2></header>
      {error || catalog?.error ? <div role="alert" className="error-state">{error ?? catalog?.error} <button type="button" className="btn" disabled={busy} onClick={() => void resource.refresh()}>Retry</button></div> : null}
      {!catalog && !error ? <span role="status">Loading coverage…</span> : null}
      {catalog ? <>
        <div className="coverage-counts" role="status"><span><i className="coverage-swatch coverage-available" />{additionalCount} available</span><span><i className="coverage-swatch coverage-installed" />{installedIds.size} installed</span></div>
        {release ? <>
          {release.partitioning === "local-areas" ? <span className="coverage-selection">Choose where hikes start. Downloads include surrounding trails for hikes up to {MAX_ROUTE_DISTANCE_MILES} miles.</span> : null}
          {namedList ? <section aria-label="Trail regions">
            <label className="coverage-search">Find a region<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <div className="coverage-region-list">{visibleSections.map(section => <label className="coverage-region" key={section.id}>
              <input type="checkbox" checked={selectedIds.has(section.id)} disabled={!onSelectionChange}
                onChange={event => onSelectionChange?.(event.target.checked ? [...selectedIds, section.id] : [...selectedIds].filter(id => id !== section.id))} />
              <span>{regionName(section)}{" "}<small>{downloading.has(section.id) ? "Downloading" : installedIds.has(section.id) ? "Downloaded" : "Available"}</small></span>
            </label>)}</div>
            {!visibleSections.length ? <span>No matching regions.</span> : null}
          </section> : null}
          {!selectedIds.size && !namedList ? <span className="coverage-selection">Select {unit === "area" ? "an" : "a"} {unit} on the map.</span> : null}
          {selectedIds.size || updating ? <div className="coverage-selection" role="status">{selectedIds.size ? `${selectedIds.size} ${unit}${selectedIds.size === 1 ? "" : "s"} selected` : "Update downloaded trails"} · up to {bytes(selectedBytes)} download · {bytes(installedBytes)} on device</div> : null}
          {selectedIds.size > 0 && release.limitations.some(value => /international border|US-only|United States.only/i.test(value)) ? <span className="coverage-selection">US trails only. Routes stop at the international border.</span> : null}
          {selectedSections.some(({ network }) => network?.sourceBoundaryLimited) ? <span className="coverage-selection">Trails may continue beyond the available data.</span> : null}
          <div className="action-row">
            {selectedIds.size ? <button type="button" className="btn" onClick={showSelectedArea}>Show selected area</button> : null}
            {selectedIds.size || updating ? <button type="button" className="btn" disabled={busy || (updating ? unavailableInstalled.length > 0 : !downloadable)} onClick={() => request && void resource.start(request)}>{updating ? "Update" : "Download"}</button> : null}
            {removable.length ? <button type="button" className="btn" disabled={busy} onClick={() => void resource.remove(removable)}>Remove selected coverage</button> : null}
            {unavailableInstalled.length ? <button type="button" className="btn" disabled={busy} onClick={() => void resource.remove(unavailableInstalled)}>Remove unavailable {unit}s ({unavailableInstalled.length})</button> : null}
          </div>
        </> : !catalog.error ? <span>No trail downloads available yet.</span> : null}
        {activeJobs.length ? <section className="coverage-downloads" aria-label="Active downloads">{activeJobs.map((job) => <article key={job.id} className="coverage-download" aria-label="Trail download">
          <header><strong>{job.sectionIds.length === 1 && sections.find(section => section.id === job.sectionIds[0])?.name || `${job.sectionIds.length} ${unit}${job.sectionIds.length === 1 ? "" : "s"}`}</strong><span>{job.status}</span></header>
          <div role="status">{bytes(job.downloadedBytes)} / {bytes(job.totalBytes)}</div>
          <progress value={job.downloadedBytes} max={Math.max(1,job.totalBytes)} aria-label="Download progress" />
          {job.error ? <div className="error-state">{job.error}</div> : null}
          <footer className="action-row">{["queued","running"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"pause")}>Pause</button> : null}
          {["paused","failed"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"resume")}>Resume</button> : null}
          <button className="btn" disabled={busy} onClick={() => void resource.act(job.id,"cancel")}>Cancel download</button></footer>
        </article>)}</section> : null}
      </> : null}
      {busy ? <span role="status">Updating…</span> : null}
    </div>
  </aside>;
}
