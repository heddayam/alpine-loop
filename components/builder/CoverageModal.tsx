"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CoverageRequest, CoverageUnit } from "@/lib/contracts/coverage";
import { useDialogFocus } from "./useDialogFocus";
import { processingCoverage, useCoverage } from "./useCoverage";

type Geometry = NonNullable<CoverageRequest["geometry"]>;
const unitLabels: Record<CoverageUnit["status"], string> = { pending: "Requested", processing: "Processing", prepared: "Ready to install", installed: "Installed", unavailable: "Unavailable" };
function bytes(value: number | null) { return value === null ? "Unknown until sources are checked" : value < 1024 * 1024 ? `${Math.round(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function extent(geometry: Geometry) {
  const points = geometry.type === "Polygon" ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
  const bounds = points.reduce(([west, south, east, north], [lon, lat]) => [Math.min(west, lon), Math.min(south, lat), Math.max(east, lon), Math.max(north, lat)], [Infinity, Infinity, -Infinity, -Infinity]);
  return bounds.map((value) => value.toFixed(3)).join(", ");
}

export function CoverageModal({ open, onClose, geometry, onChanged }: { open: boolean; onClose: () => void; geometry?: Geometry; onChanged?: () => void }) {
  const dialogRef = useDialogFocus(open, onClose);
  const resource = useCoverage(open);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [useDrawn, setUseDrawn] = useState(false);
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
  if (!open) return null;
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="settings-modal coverage-modal" role="dialog" aria-modal="true" aria-labelledby="coverage-title" aria-describedby="coverage-description">
      <header className="settings-modal-heading"><h2 id="coverage-title">Manage coverage</h2><button type="button" className="settings-close" aria-label="Close coverage" onClick={onClose}>×</button></header>
      <div className="settings-modal-content coverage-content">
        <p id="coverage-description">Prepare hiking coverage on this device. Routes use installed coverage; choosing an area here does not change your search.</p>
        <p className="coverage-caveat">Coverage may be partial. Map sources can omit trails and do not confirm current access or trail conditions.</p>
        {error ? <div role="alert" className="error-state">{error} <button type="button" className="btn" disabled={busy} onClick={() => void resource.refresh()}>Retry</button></div> : null}
        {!catalog && !error ? <p role="status">Loading coverage…</p> : null}
        {catalog ? <>
          <CoveragePreview installed={catalog.installed?.geometry}
            requested={plan?.geometry ? [plan.geometry] : [...catalog.collections.filter((item) => collectionIds.includes(item.id)).map((item) => item.geometry), ...(useDrawn && geometry ? [geometry] : [])]}
            units={plan?.units ?? (catalog.jobs.find(processingCoverage) ?? catalog.jobs[0])?.plan.units ?? []}
            regions={catalog.collections} />
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
          {plan ? <section className="coverage-plan" aria-labelledby="coverage-plan-title"><h3 id="coverage-plan-title">Installation preview</h3><p>{plan.units.length} requested sections · {plan.request.memoryLimitMiB} MiB memory budget</p><p className="hint">Extent: {extent(plan.geometry)}</p><dl><div><dt>Download</dt><dd>{bytes(plan.estimates.downloadBytes)}</dd></div><div><dt>Temporary space</dt><dd>{bytes(plan.estimates.temporaryBytes)}</dd></div><div><dt>Reusable data</dt><dd>{bytes(plan.estimates.reusableBytes)}</dd></div></dl>{plan.warnings.map((warning) => <p className="job-note" key={warning}>{warning}</p>)}<UnitSummary units={plan.units} /><button type="button" className="btn" disabled={busy || plan.units.length === 0 || plan.units.every((unit) => unit.status === "unavailable")} onClick={() => void resource.start()}>Start installation</button></section> : null}
          <section aria-labelledby="coverage-jobs-title"><h3 id="coverage-jobs-title">Installations</h3>{catalog.jobs.length === 0 ? <p>No installations requested yet.</p> : catalog.jobs.map((job) => <article className="job-card" key={job.id} aria-label={`Installation ${job.id}`}><header><strong>{job.plan.request.collectionIds.map((id) => catalog.collections.find((collection) => collection.id === id)?.name ?? id).join(", ") || "Drawn area"}</strong><span className="job-status">{job.status}</span></header><p role="status">{job.stage} · {job.completedUnits} of {job.totalUnits} sections ready</p><progress value={job.completedUnits} max={Math.max(1, job.totalUnits)} aria-label="Coverage preparation progress" /><UnitSummary units={job.plan.units} />{job.error ? <p className="error-state">{job.error}</p> : null}<footer>{["queued", "running"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "pause")}>Pause</button> : null}{["paused", "failed"].includes(job.status) ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "resume")}>Resume</button> : null}{processingCoverage(job) || job.status === "paused" ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "cancel")}>Cancel installation</button> : null}{job.status === "paused" && job.plan.units.some((unit) => unit.status === "prepared") ? <button className="btn" disabled={busy} onClick={() => void resource.act(job.id, "publish")}>Install ready sections</button> : null}</footer>{job.snapshot ? <p className="hint">Installed {job.snapshot.unitIds.length} sections.</p> : null}</article>)}</section>
        </> : null}
        {busy ? <p role="status">Updating coverage…</p> : null}
      </div>
    </div>
  </div>;
}
function UnitSummary({ units }: { units: CoverageUnit[] }) {
  return <details className="coverage-units"><summary>Coverage status ({units.length} sections)</summary><ul>{units.map((unit, index) => <li key={unit.id}><strong>{unitLabels[unit.status]}</strong> · Section {index + 1}{unit.reason ? ` — ${coverageReason(unit.reason)}` : ""}</li>)}</ul></details>;
}

function coverageReason(reason: string) {
  if (reason === "outside-configured-source-coverage") return "No map source covers this area.";
  if (reason === "intentionally-excluded:yakama-reservation") return "Yakama Reservation is excluded from coverage.";
  return reason;
}

/** A north-up geographic overview without a second interactive map or network requests. */
function CoveragePreview({ installed, requested, units, regions }: {
  installed?: Geometry; requested: Geometry[]; units: CoverageUnit[];
  regions: { name: string; geometry: Geometry }[];
}) {
  const patternId = useId();
  const layers = [
    ...requested.map((geometry, index) => ({ id: `request-${index}`, geometry, status: "pending" as const })),
    ...units.filter((unit) => unit.status !== "unavailable" && unit.status !== "installed"),
    ...(installed ? [{ id: "installed", geometry: installed, status: "installed" as const }] : []),
    ...units.filter((unit) => unit.status === "installed" || unit.status === "unavailable"),
  ];
  const polygons = (geometry: Geometry) => geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const points = (layers.length ? layers : regions).flatMap(({ geometry }) => polygons(geometry).flat(2));
  if (!points.length) return null;
  const [west, south, east, north] = points.reduce(([w,s,e,n],[x,y]) => [Math.min(w,x),Math.min(s,y),Math.max(e,x),Math.max(n,y)], [Infinity,Infinity,-Infinity,-Infinity]);
  const longitudeScale = Math.max(0.01, Math.cos((north + south) / 2 * Math.PI / 180));
  const width = Math.max((east-west)*longitudeScale, 0.00001), height = Math.max(north-south, 0.00001);
  const scale = Math.min(496/width, 208/height);
  const project = ([lon,lat]: number[]) => [(lon-(west+east)/2)*longitudeScale*scale+260, ((north+south)/2-lat)*scale+120];
  const shape = (rings: number[][][]) => rings.map((ring) => ring.map((point,index) => `${index ? "L" : "M"}${project(point).map((value)=>value.toFixed(2)).join(",")}`).join(" ")+"Z").join(" ");
  return <figure className="coverage-preview">
    <svg viewBox="0 0 520 260" role="img" aria-label="Coverage map preview">
      <title>Installed and requested hiking coverage</title>
      <desc>North is up. Outlines provide geographic context. Colors and line patterns distinguish requested, processing, ready, installed, and unavailable areas.</desc>
      <defs><pattern id={patternId} patternUnits="userSpaceOnUse" width="7" height="7"><path d="M0,7 L7,0" stroke="#b91c1c" strokeWidth="1" /></pattern></defs>
      {regions.flatMap((region,index) => polygons(region.geometry).map((rings,part) => <path key={`region-${index}-${part}`} d={shape(rings)} className="coverage-context" fillRule="evenodd" />))}
      {layers.flatMap((layer) => polygons(layer.geometry).map((rings,index) => <path key={`${layer.id}-${index}`} d={shape(rings)} className={`coverage-shape coverage-${layer.status}`} data-status={layer.status} fillRule="evenodd" {...(layer.status === "unavailable" ? { fill: `url(#${patternId})` } : {})}><title>{unitLabels[layer.status]}</title></path>))}
      {regions.map((region,index) => { const coordinates=polygons(region.geometry).flat(2); const center=coordinates.reduce(([x,y],p)=>[x+p[0],y+p[1]],[0,0]).map((value)=>value/coordinates.length); const [x,y]=project(center); return x>15&&x<505&&y>25&&y<218 ? <text key={index} x={x} y={y} textAnchor="middle" className="coverage-place">{region.name}</text> : null; })}
      <text x="500" y="19" textAnchor="end" className="coverage-axis">N ↑</text>
      <text x="12" y="250" className="coverage-axis">{south.toFixed(2)}° to {north.toFixed(2)}° latitude</text>
      <text x="508" y="250" textAnchor="end" className="coverage-axis">{west.toFixed(2)}° to {east.toFixed(2)}° longitude</text>
    </svg>
    <figcaption><ul className="coverage-legend" aria-label="Coverage map legend">{Object.entries(unitLabels).map(([status,label]) => <li key={status}><span className={`coverage-swatch coverage-${status}`} aria-hidden="true" />{label}</li>)}</ul>
      <p className="hint">Requested and processing areas are not available for routes yet. Ready sections become available after installation. Unavailable areas remain excluded.</p>
    </figcaption>
  </figure>;
}
