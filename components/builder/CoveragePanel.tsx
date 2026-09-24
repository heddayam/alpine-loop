"use client";

import { useEffect, useRef, useState } from "react";
import type { CoverageRequest, CoverageUnit } from "@/lib/contracts/coverage";
import type { CoverageOverlay } from "../map/HikeMap";
import { processingCoverage, useCoverage } from "./useCoverage";

type Geometry = NonNullable<CoverageRequest["geometry"]>;
const unitLabels: Record<CoverageUnit["status"], string> = { pending: "Requested", processing: "Processing", prepared: "Ready to install", installed: "Installed", unavailable: "Unavailable" };
function bytes(value: number | null) { return value === null ? "Not yet estimated" : value < 1024 * 1024 ? `${Math.round(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function extent(geometry: Geometry) {
  const points = geometry.type === "Polygon" ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
  const bounds = points.reduce(([west, south, east, north], [lon, lat]) => [Math.min(west, lon), Math.min(south, lat), Math.max(east, lon), Math.max(north, lat)], [Infinity, Infinity, -Infinity, -Infinity]);
  return bounds.map((value) => value.toFixed(3)).join(", ");
}

export function CoveragePanel({ open, geometry, onChanged, onMapChange, onClose }: { open: boolean; onClose?: () => void; geometry?: Geometry; onChanged?: () => void; onMapChange?: (overlay: CoverageOverlay) => void }) {
  const resource = useCoverage(open);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [useDrawn, setUseDrawn] = useState(true);
  const [memory, setMemory] = useState("4096");
  const [offline, setOffline] = useState(false);
  const { catalog, plan, busy, error } = resource;
  const previousSnapshot = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!catalog) return;
    const next = catalog.installed ? `${catalog.installed.id}:${catalog.installed.dataVersion}` : null;
    if (previousSnapshot.current !== undefined && next !== previousSnapshot.current) onChanged?.();
    previousSnapshot.current = next;
  }, [catalog, onChanged]);
  const validMemory = Number.isInteger(Number(memory)) && Number(memory) >= 512 && Number(memory) <= 65536;
  const requestReady = validMemory && (collectionIds.length > 0 || (useDrawn && Boolean(geometry)));
  const requested = plan ? [plan.geometry] : [...(catalog?.collections ?? []).filter((item) => collectionIds.includes(item.id)).map((item) => item.geometry), ...(useDrawn && geometry ? [geometry] : [])];
  const units = plan?.units ?? (catalog?.jobs.find(processingCoverage) ?? catalog?.jobs[0])?.plan.units ?? [];
  const focus = requested.length ? requested : catalog?.installed ? [catalog.installed.geometry] : (catalog?.collections ?? []).slice(0,1).map((item) => item.geometry);
  const points = focus.flatMap((item) => item.type === "Polygon" ? item.coordinates.flat() : item.coordinates.flat(2));
  const mapKey = JSON.stringify({ features: { type: "FeatureCollection", features: [
    ...requested.map((geometry) => ({ geometry, status: "pending" })),
    ...(catalog?.installed ? [{ geometry: catalog.installed.geometry, status: "installed" }] : []), ...units,
  ].map(({geometry,status}) => ({type:"Feature",geometry,properties:{status}})) },
    focus: points.length ? points.reduce(([w,s,e,n],[x,y]) => [Math.min(w,x),Math.min(s,y),Math.max(e,x),Math.max(n,y)], [Infinity,Infinity,-Infinity,-Infinity]) : null });
  useEffect(() => { onMapChange?.(JSON.parse(mapKey)); }, [mapKey, onMapChange]);
  const geometryKey = JSON.stringify(geometry);
  const {clearPlan} = resource;
  useEffect(() => { clearPlan(); }, [geometryKey, clearPlan]);
  return <aside className="builder-panel coverage-panel" hidden={!open} aria-labelledby="coverage-title">
      <div className="builder-scroll coverage-content">
        {onClose ? <button type="button" className="btn-link" onClick={onClose}>← Back to planning</button> : null}
        <h2 id="coverage-title">Manage coverage</h2>
        <p id="coverage-description">Prepare hiking coverage on this device. Routes use installed coverage; choosing an area here does not change your search.</p>
        <p className="coverage-caveat">Coverage may be partial. Map sources can omit trails and do not confirm current access or trail conditions.</p>
        {error ? <div role="alert" className="error-state">{error} <button type="button" className="btn" disabled={busy} onClick={() => void resource.refresh()}>Retry</button></div> : null}
        {!catalog && !error ? <p role="status">Loading coverage…</p> : null}
        {catalog ? <>
          <ul className="coverage-legend" aria-label="Coverage map legend">{Object.entries(unitLabels).map(([status,label]) => <li key={status}><span className={`coverage-swatch coverage-${status}`} aria-hidden="true" />{label}</li>)}</ul>
          <p className="hint">Use the map to draw installation coverage. Requested and processing areas are not available for routes yet. Ready sections become available after installation.</p>
          <section aria-labelledby="installed-title"><h3 id="installed-title">Installed</h3>{catalog.installed ? <><p>{catalog.installed.unitIds.length} sections installed · {new Date(catalog.installed.createdAt).toLocaleDateString()}</p><p className="hint">Extent (west, south, east, north): {extent(catalog.installed.geometry)}</p>{catalog.installed.limitations.map((text) => <p className="hint" key={text}>{text}</p>)}</> : <p>No new coverage installed yet. Existing regional coverage remains available.</p>}</section>
          <form onSubmit={(event) => { event.preventDefault(); if (requestReady) void resource.preview({ collectionIds, ...(useDrawn && geometry ? { geometry } : {}), memoryLimitMiB: Number(memory), offline }); }}>
            <fieldset disabled={busy}><legend>Choose coverage</legend>
              {catalog.collections.map((collection) => <label className="coverage-choice" key={collection.id}><input type="checkbox" checked={collectionIds.includes(collection.id)} onChange={(event) => { const checked = event.currentTarget.checked; setCollectionIds((current) => checked ? [...current, collection.id] : current.filter((id) => id !== collection.id)); resource.clearPlan(); }} /><span>{collection.name}{collection.limitations.map((text) => <small key={text}>{text}</small>)}</span></label>)}
              <label className="coverage-choice"><input type="checkbox" checked={useDrawn} disabled={!geometry} onChange={(event) => { setUseDrawn(event.currentTarget.checked); resource.clearPlan(); }} /><span>Use drawn area<small>{geometry ? `Extent: ${extent(geometry)}` : "Draw an area on the map first."}</small></span></label>
              <label className="coverage-memory" htmlFor="coverage-memory">Memory budget (MiB)<input id="coverage-memory" className="control" type="number" min="512" max="65536" step="1" value={memory} onChange={(event) => { setMemory(event.currentTarget.value); resource.clearPlan(); }} /></label>
              <label className="coverage-choice"><input type="checkbox" checked={offline} onChange={(event) => { setOffline(event.currentTarget.checked); resource.clearPlan(); }} /><span>Use cached sources only<small>Missing downloads will be reported as unavailable.</small></span></label>
              <button type="submit" className="btn" disabled={!requestReady}>Preview installation</button>
            </fieldset>
          </form>
          {catalog.prerequisites.length ? <section aria-labelledby="prerequisites-title"><h3 id="prerequisites-title">Requirements</h3><ul>{catalog.prerequisites.map((item) => <li key={item.id}><strong>{item.available ? "Ready" : "Missing"}: {item.id}</strong> — {item.instructions}</li>)}</ul></section> : null}
          {plan ? <section className="coverage-plan" aria-labelledby="coverage-plan-title"><h3 id="coverage-plan-title">Installation preview</h3><p>{plan.units.length} requested sections · {plan.request.memoryLimitMiB} MiB memory budget</p><p className="hint">Extent: {extent(plan.geometry)}</p><dl><div><dt>Download</dt><dd>{bytes(plan.estimates.downloadBytes)}</dd></div><div><dt>Temporary space</dt><dd>{bytes(plan.estimates.temporaryBytes)}</dd></div><div><dt>Cached data</dt><dd>{bytes(plan.estimates.reusableBytes)}</dd></div></dl>{plan.warnings.map((warning) => <p className="job-note" key={warning}>{warning}</p>)}<UnitSummary units={plan.units} /><button type="button" className="btn" disabled={busy || plan.units.length === 0 || plan.units.every((unit) => unit.status === "unavailable")} onClick={() => void resource.start()}>Start installation</button></section> : null}
          <section aria-labelledby="coverage-jobs-title"><h3 id="coverage-jobs-title">Installations</h3>{catalog.jobs.length === 0 ? <p>No installations requested yet.</p> : catalog.jobs.map((job) => <article className="job-card" key={job.id} aria-label={`Installation ${job.id}`}><header><strong>{job.plan.request.collectionIds.map((id) => catalog.collections.find((collection) => collection.id === id)?.name ?? id).join(", ") || "Drawn area"}</strong><span className="job-status">{job.status}</span></header><p role="status">{job.stage} · {job.completedUnits} of {job.totalUnits} sections ready</p><progress value={job.completedUnits} max={Math.max(1, job.totalUnits)} aria-label="Coverage preparation progress" /><UnitSummary units={job.plan.units} />{job.error ? <p className="error-state">{job.error}</p> : null}<footer>{["queued", "running"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "pause")}>Pause</button> : null}{["paused", "failed"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "resume")}>Resume</button> : null}{processingCoverage(job) || job.status === "paused" ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "cancel")}>Cancel installation</button> : null}{job.status === "paused" && job.plan.units.some((unit) => unit.status === "prepared") ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "publish")}>Install ready sections</button> : null}</footer>{job.snapshot ? <p className="hint">Installed {job.snapshot.unitIds.length} sections.</p> : null}</article>)}</section>
        </> : null}
        {busy ? <p role="status">Updating coverage…</p> : null}
      </div>
  </aside>;
}
function UnitSummary({ units }: { units: CoverageUnit[] }) {
  return <details className="coverage-units"><summary>Coverage status ({units.length} sections)</summary><ul>{units.map((unit, index) => <li key={unit.id}><strong>{unitLabels[unit.status]}</strong> · Section {index + 1}{unit.reason ? ` — ${coverageReason(unit.reason)}` : ""}</li>)}</ul></details>;
}

function coverageReason(reason: string) {
  if (reason === "outside-configured-source-coverage") return "No map source covers this area.";
  if (reason === "intentionally-excluded:yakama-reservation") return "Yakama Reservation is excluded from coverage.";
  return reason;
}

