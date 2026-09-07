"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Polygon } from "geojson";
import { useRouter } from "next/navigation";
import { DRIVE_TIME_DURATIONS_MINUTES, originSchema, type AppSettingsV1, type GradePresetId } from "@/lib/contracts";
import { searchCatalogSchema, searchResultSchema, searchRequestSchema, routeJobV2Schema, routeJobResultsPageV2Schema, type SearchCatalog, type SearchRequest } from "@/lib/contracts/search";
import { HikeMap } from "../map/HikeMap";
import { ResultsPanel } from "../results/ResultsPanel";
import type { RouteResults } from "../results/types";
import { JobsModal } from "./JobsModal";
import { GradePresetInput } from "./GradePresetInput";
import { RangeInput } from "./RangeInput";
import { RegionMultiSelect } from "./RegionMultiSelect";
import { SettingsModal } from "./SettingsModal";
import { usePreferences } from "./usePreferences";
import { useJobs, ACTIVE_JOB_STATUSES } from "./useJobs";
import { DEFAULT_BUILDER_DRAFT, builderValues, type Bounds, type BuilderDraft, type DriveTimeDraft, type RangeField } from "./types";
import { parseSearchCriteria } from "./validation";

type Workspace = { status: "idle" } | { status: "done"; results: RouteResults } | {
  status: "loading" | "error";
  kind: "quick" | "saved";
  previous?: RouteResults;
  jobId?: string;
  message?: string;
};

function boundsGeometry([west, south, east, north]: Bounds): Polygon {
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}
function patchRange(setValues: React.Dispatch<React.SetStateAction<BuilderDraft>>, key: keyof Pick<BuilderDraft, "distanceMiles" | "elevationGainFeet" | "maximumElevationFeet">, next: RangeField) {
  setValues((current) => ({ ...current, [key]: next }));
}
function parseError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  if (typeof error === "string") return error;
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback;
}
function parseCoordinateOrigin(text: string) {
  const parts = text.split(/[ ,]+/).filter(Boolean).map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  const [lat, lon] = parts;
  return originSchema.safeParse({ lat, lon, label: `${lat!.toFixed(5)}, ${lon!.toFixed(5)}` });
}
async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(parseError(payload, "The request could not be completed."));
  return payload;
}

export function HikeBuilder({ restoreJobId }: { restoreJobId?: string }) {
  const router = useRouter();
  const [catalog, setCatalog] = useState<SearchCatalog>();
  const [catalogError, setCatalogError] = useState("");
  const [drawnBounds, setDrawnBounds] = useState<Bounds | null>(null);
  const [selectedRegionIds, setSelectedRegionIds] = useState<string[]>([]);
  const [driveDraft, setDriveDraft] = useState<DriveTimeDraft>({ originText: "", originSuggestions: [], durationMinutes: 30, state: "idle" });
  const preferences = usePreferences();
  const { settings: appSettings, loaded: settingsLoaded, error: settingsError } = preferences;
  const [draft, setValues] = useState<BuilderDraft>(DEFAULT_BUILDER_DRAFT);
  const values = builderValues(appSettings, draft);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>({ status: "idle" });
  const [focus, setFocus] = useState<{ routeId?: string; segmentId?: string; hoveredRouteId?: string; hoveredSegmentId?: string }>({});
  const { routeId: selectedRouteId, segmentId: selectedSegmentId, hoveredRouteId, hoveredSegmentId } = focus;
  const setHoveredRouteId = useCallback((hoveredRouteId?: string) => setFocus((current) => ({ ...current, hoveredRouteId })), []);
  const setHoveredSegmentId = useCallback((hoveredSegmentId?: string) => setFocus((current) => ({ ...current, hoveredSegmentId })), []);
  const setSelectedSegmentId = useCallback((segmentId: string) => setFocus((current) => ({ ...current, segmentId })), []);
  const [nearMissesOpen, setNearMissesOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const jobsResource = useJobs(jobsOpen);
  const { jobs, refresh: refreshJobs, announcement: jobsAnnouncement } = jobsResource;
  const [batchLaunching, setBatchLaunching] = useState(false);
  const batchLaunchRef = useRef(false);
  const [launchMessage, setLaunchMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<"plan" | "results" | "route">("plan");
  const [mapExpanded, setMapExpanded] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const originRequestSequenceRef = useRef(0);
  const routeResults = workspace.status === "done" ? workspace.results : workspace.status === "idle" ? null : workspace.previous ?? null;
  const savedResults = routeResults?.kind === "saved" ? routeResults : undefined;
  const generationState = workspace.status === "error" ? "error" : routeResults ? "done" : workspace.status;
  const generationMessage = workspace.status === "error" ? workspace.message : launchMessage;
  const activeJobCount = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;
  const ready = settingsLoaded && Boolean(catalog?.coverages.length);

  useEffect(() => {
    const controller = new AbortController();
    void requestJson("/api/search/catalog", { signal: controller.signal }).then((raw) => {
      const next = searchCatalogSchema.parse(raw);
      if (!controller.signal.aborted) setCatalog(next);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setCatalogError(error instanceof Error ? error.message : "Map data is unavailable."); });
    return () => controller.abort();
  }, []);
  useEffect(() => () => { operation.current?.abort(); originRequestSequenceRef.current += 1; }, []);

  // Draft edits cancel pending view work without changing a completed snapshot.
  const editDraft = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    setWorkspace((current) => current.status === "loading" || current.status === "error"
      ? current.previous ? { status: "done", results: current.previous } : { status: "idle" }
      : current);
    setValidationErrors([]);
    setLaunchMessage("");
  }, []);
  const clearResults = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    setWorkspace({ status: "idle" });
    setFocus({});
    setPanel("plan");
  }, []);
  const changeDrawnBounds = useCallback((bounds: Bounds | null) => {
    clearResults();
    setDrawnBounds(bounds);
  }, [clearResults]);
  const runView = useCallback(async (load: (signal: AbortSignal) => Promise<RouteResults>, kind: "quick" | "saved", jobId?: string, previous?: RouteResults) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setWorkspace({ status: "loading", kind, jobId, previous });
    setPanel("results");
    setMapExpanded(false);
    try {
      const results = await load(controller.signal);
      if (controller.signal.aborted || operation.current !== controller) return;
      setWorkspace({ status: "done", results });
      setFocus({ routeId: (results.exact[0] ?? results.nearMisses[0])?.id });
      setNearMissesOpen(results.exact.length === 0);
      setJobsOpen(false);
      setPanel("results");
      router.replace("/");
    } catch (error) {
      if (!controller.signal.aborted && operation.current === controller) setWorkspace({ status: "error", kind, jobId, previous, message: error instanceof Error ? error.message : "Search results could not be loaded." });
    } finally { if (operation.current === controller) operation.current = null; }
  }, [router]);
  const loadJob = useCallback((id: string, cursor?: string, previous?: RouteResults) => runView(async (signal) => {
    const query = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
    const page = routeJobResultsPageV2Schema.parse(await requestJson(`/api/route-jobs/${encodeURIComponent(id)}/results?${query}`, { signal, cache: "no-store" }));
    return { kind: "saved", job: page.job, nextCursor: page.nextCursor,
      exact: page.results.filter((result) => result.matchType === "exact").map(({ route }) => route),
      nearMisses: page.results.filter((result) => result.matchType === "near-miss").map(({ route }) => route) };
  }, "saved", id, previous), [runView]);
  useEffect(() => {
    if (!restoreJobId) return;
    void loadJob(restoreJobId);
    const restoredOperation = operation.current;
    return () => restoredOperation?.abort();
  }, [loadJob, restoreJobId]);

  const selectRoute = useCallback((routeId: string) => {
    setFocus({ routeId });
    setPanel("route");
    setMapExpanded(false);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeJobs = useCallback(() => {
    setWorkspace((current) => {
      if (current.status !== "loading" || current.kind !== "saved") return current;
      operation.current?.abort();
      operation.current = null;
      return current.previous ? { status: "done", results: current.previous } : { status: "idle" };
    });
    setJobsOpen(false);
    setPanel("plan");
  }, []);
  const saveSettings = async (settings: AppSettingsV1) => {
    if (!await preferences.save(settings)) return false;
    editDraft();
    return true;
  };
  const changeGradePreference = (patch: { gradeConstraintEnabled?: boolean; selectedGradePreset?: GradePresetId }) => { void preferences.change((current) => ({ ...current, ...patch })); editDraft(); };
  const changeLoopPreference = (patch: Partial<AppSettingsV1["loopOptions"]>) => { void preferences.change((current) => ({ ...current, loopOptions: { ...current.loopOptions, ...patch } })); editDraft(); };
  useEffect(() => {
    if (driveDraft.state !== "suggesting" || driveDraft.origin || driveDraft.originText.trim().length < 2 || parseCoordinateOrigin(driveDraft.originText)?.success) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/geocoding/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: driveDraft.originText.trim() }), signal: controller.signal })
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(parseError(payload, "Origin suggestions are unavailable."));
          const originSuggestions = payload && typeof payload === "object" && "suggestions" in payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
          setDriveDraft((current) => current.originText === driveDraft.originText ? { ...current, originSuggestions, state: "idle" } : current);
        }).catch((error: unknown) => { if (!controller.signal.aborted) setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "Origin suggestions are unavailable." })); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [driveDraft.origin, driveDraft.originText, driveDraft.state]);

  const selectOriginSuggestion = async (suggestion: { label: string; magicKey: string }) => {
    const sequence = ++originRequestSequenceRef.current;
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined, originSuggestions: [] }));
    try {
      const response = await fetch("/api/geocoding/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: suggestion.label, magicKey: suggestion.magicKey }) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "That origin could not be resolved."));
      const origin = originSchema.parse(payload && typeof payload === "object" && "origin" in payload ? payload.origin : payload);
      if (sequence !== originRequestSequenceRef.current) return;
      setDriveDraft((current) => ({ ...current, originText: origin.label, origin, state: "idle", error: undefined }));
    } catch (error) { if (sequence === originRequestSequenceRef.current) setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "That origin could not be resolved." })); }
  };

  const useCurrentLocation = () => {
    const sequence = ++originRequestSequenceRef.current;
    editDraft();
    setDriveDraft((current) => ({ ...current, origin: undefined, originText: "Current location", originSuggestions: [], state: "resolving", error: undefined }));
    if (!navigator.geolocation) { setDriveDraft((current) => ({ ...current, state: "error", error: "Location is not available in this browser." })); return; }
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (sequence !== originRequestSequenceRef.current) return;
      const origin = { lon: coords.longitude, lat: coords.latitude, label: "Current location" };
      setDriveDraft((current) => ({ ...current, origin, originText: origin.label, state: "idle" }));
    }, () => { if (sequence === originRequestSequenceRef.current) setDriveDraft((current) => ({ ...current, state: "error", error: "Location permission was denied. Type an origin or coordinates instead." })); }, { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 });
  };


  const prepareRequest = (): SearchRequest | null => {
    if (!ready) return null;
    const parsed = parseSearchCriteria(values);
    if (!parsed.success) { setValidationErrors(parsed.errors); return null; }
    if (!drawnBounds && driveDraft.originText.trim() && !driveDraft.origin) {
      setValidationErrors(["Choose a suggested origin or clear the field to search named regions."]);
      return null;
    }
    const area = drawnBounds ? { mode: "drawn-area" as const, bbox: drawnBounds }
      : driveDraft.origin ? { mode: "drive-time" as const, origin: driveDraft.origin, durationMinutes: driveDraft.durationMinutes, regionIds: selectedRegionIds }
      : { mode: "named-regions" as const, regionIds: selectedRegionIds };
    const request = searchRequestSchema.safeParse({ area, criteria: parsed.criteria, limit: parsed.limit });
    if (!request.success) { setValidationErrors(["Choose named regions, resolve an origin, or draw a boundary."]); return null; }
    setValidationErrors([]);
    return request.data;
  };
  const runQuick = () => {
    const request = prepareRequest();
    if (!request) return;
    setLaunchMessage("");
    void runView(async (signal) => ({ kind: "quick", ...searchResultSchema.parse(await requestJson("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal })) }), "quick");
  };
  const launchBatch = async () => {
    if (batchLaunchRef.current) return;
    const request = prepareRequest();
    if (!request) return;
    batchLaunchRef.current = true;
    setBatchLaunching(true);
    try {
      const raw = await requestJson("/api/route-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ area: request.area, criteria: request.criteria }) });
      routeJobV2Schema.parse(raw);
      setLaunchMessage("Full search queued. Every eligible trailhead will be attempted, with up to ten exact routes per start.");
      setJobsOpen(true);
      await refreshJobs(true);
    } catch (error) { setLaunchMessage(error instanceof Error ? error.message : "Full search could not be started."); }
    finally { batchLaunchRef.current = false; setBatchLaunching(false); }
  };
  const generatedRoutes = useMemo(() => routeResults ? [...routeResults.exact, ...routeResults.nearMisses] : [], [routeResults]);
  const mappedRoutes = nearMissesOpen ? generatedRoutes : routeResults?.exact ?? [];
  const viewedRequest = routeResults?.kind === "quick" ? routeResults.request : savedResults?.job.request;
  const viewedArea = routeResults?.kind === "quick" ? routeResults.area : savedResults?.job.area;
  const toggleNearMisses = (open: boolean) => {
    setNearMissesOpen(open);
    if (!open) {
      setFocus((current) => ({ routeId: routeResults?.exact.some(({ id }) => id === current.routeId) ? current.routeId : routeResults?.exact[0]?.id }));
    }
  };
  const hasResultsPanel = workspace.status !== "idle";

  return (
    <main className="app-frame">
      <header className="topbar">
        <h1>Alpine Loop</h1>
        <div className="topbar-actions">
          <button type="button" className="chip-button" aria-haspopup="dialog" aria-expanded={jobsOpen} aria-label={activeJobCount ? `Jobs (${activeJobCount})` : "Jobs"} onClick={() => { setJobsOpen(true); void refreshJobs(true); }}>
            Jobs{activeJobCount ? <span className="chip-count" aria-hidden="true">{activeJobCount}</span> : null}
          </button>
          <button type="button" className="chip-button" aria-haspopup="dialog" aria-expanded={settingsOpen} disabled={!settingsLoaded} onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">{jobsAnnouncement}</p>
        {settingsError ? <p className="settings-error-banner" role="alert">{settingsError}</p> : null}
      </header>

      {settingsOpen ? <SettingsModal open settings={appSettings} onSave={saveSettings} onClose={closeSettings} /> : null}
      <JobsModal open={jobsOpen} jobs={jobs} loadState={jobsResource.loadState} loadError={jobsResource.error || (workspace.status === "error" && workspace.kind === "saved" ? workspace.message : undefined)} refreshedAt={jobsResource.refreshedAt} onRefresh={refreshJobs} onOpenResults={(id) => void loadJob(id, undefined, routeResults ?? undefined)} onMutate={jobsResource.mutate} pendingByJob={jobsResource.pending} openingJobId={workspace.status === "loading" && workspace.kind === "saved" ? workspace.jobId : undefined} onClose={closeJobs} />

      <div className={mapExpanded ? "workspace map-expanded" : "workspace"}>
        <section className="workspace-panel" aria-label="Route planner">
          <nav className="panel-nav" aria-label="Workspace panels">
            <button type="button" aria-pressed={panel === "plan"} onClick={() => setPanel("plan")}>Plan</button>
            <button type="button" aria-pressed={panel !== "plan"} disabled={!hasResultsPanel} onClick={() => setPanel("results")}>Results{routeResults ? ` (${generatedRoutes.length})` : ""}</button>
          </nav>
          <aside className="builder-panel" hidden={panel !== "plan"} aria-labelledby="builder-title">
          <div className="builder-scroll">
            <h2 id="builder-title" className="visually-hidden">Plan</h2>

            <section className="panel-section" aria-labelledby="search-area-title">
              <div className="section-head"><h3 id="search-area-title">Search area</h3></div>

              <div className="field-row">
                <label htmlFor="drive-origin">Origin</label>
                <div className="input-with-action">
                  <input id="drive-origin" className="control" type="search" aria-label="Driving origin" value={driveDraft.originText} autoComplete="off" placeholder="Address, place, or lat, lon" onChange={(event) => { const originText = event.currentTarget.value; originRequestSequenceRef.current += 1; const coordinates = parseCoordinateOrigin(originText); setDriveDraft((current) => coordinates?.success
                    ? { ...current, originText, origin: coordinates.data, originSuggestions: [], state: "idle", error: undefined }
                    : { ...current, originText, origin: current.origin?.label === originText ? current.origin : undefined, originSuggestions: [], state: "suggesting", error: undefined }); editDraft(); }} />
                </div>
              </div>
              {driveDraft.originSuggestions.length ? <ul className="suggestion-list" role="listbox" aria-label="Origin suggestions">{driveDraft.originSuggestions.map((suggestion) => <li key={suggestion.id}><button type="button" role="option" aria-selected="false" onClick={() => void selectOriginSuggestion(suggestion)}>{suggestion.label}</button></li>)}</ul> : null}
              <div className="field-extra">
                <button className="btn-link" type="button" onClick={useCurrentLocation}>Use my current location</button>
                {driveDraft.origin ? <span className="resolved-value"><code>{driveDraft.origin.lat.toFixed(4)}, {driveDraft.origin.lon.toFixed(4)}</code></span> : null}
              </div>

              <div className="field-row">
                <label htmlFor="drive-duration">Drive time</label>
                <select id="drive-duration" className="control" aria-label="Typical drive time" value={driveDraft.durationMinutes} onChange={(event) => { const durationMinutes = Number(event.currentTarget.value); setDriveDraft((current) => ({ ...current, durationMinutes })); editDraft(); }}>{DRIVE_TIME_DURATIONS_MINUTES.map((minutes) => <option value={minutes} key={minutes}>{minutes} minutes</option>)}</select>
              </div>

              <RegionMultiSelect options={catalog?.regions ?? []} selected={selectedRegionIds} disabled={!catalog} onChange={(ids) => { setSelectedRegionIds(ids); editDraft(); }} />
              {driveDraft.error ? <p className="note-error" role="alert">{driveDraft.error}</p> : null}

              <section className="boundary-block" aria-labelledby="boundary-title">
                <div className="boundary-row">
                  <h3 className="field-label" id="boundary-title">Drawn boundary</h3>
                  {drawnBounds
                    ? <output data-bounds={drawnBounds.join(",")}>Using your drawn area</output>
                    : <output className="empty">Draw an area on the map</output>}
                  {drawnBounds ? <button type="button" className="btn-link" onClick={() => { setDrawnBounds(null); editDraft(); }}>Clear</button> : null}
                </div>
                <p className="hint">An area selects starting points. Your hike can continue beyond it within installed coverage.</p>
              </section>
            </section>

            <section className="panel-section constraints" aria-labelledby="constraints-title">
              <div className="section-head"><h3 id="constraints-title">Route</h3></div>
              <div className="range-table">
                <div className="range-table-header" aria-hidden="true"><span>Constraint</span><span>Min</span><span>Max</span><span>Unit</span></div>
                <RangeInput id="distance" label="Distance" unit="mi" title="Total route distance, up to 30 miles" optional={false} value={values.distanceMiles} onChange={(next) => { patchRange(setValues, "distanceMiles", next); editDraft(); }} />
                <RangeInput id="gain" label="Elevation gain" unit="ft" title="Cumulative elevation gain" value={values.elevationGainFeet} onChange={(next) => { patchRange(setValues, "elevationGainFeet", next); editDraft(); }} />
                <RangeInput id="altitude" label="Max elevation" unit="ft" title="Highest point reached" value={values.maximumElevationFeet} onChange={(next) => { patchRange(setValues, "maximumElevationFeet", next); editDraft(); }} />
                <GradePresetInput
                  disabled={!settingsLoaded}
                  enabled={values.gradeConstraintEnabled}
                  selected={values.selectedGradePreset}
                  presets={values.gradePresets}
                  onEnabledChange={(gradeConstraintEnabled) => changeGradePreference({ gradeConstraintEnabled })}
                  onSelectedChange={(selectedGradePreset) => changeGradePreference({ selectedGradePreset })}
                />
              </div>
            </section>

            <details className="advanced" aria-labelledby="closed-route-title">
              <summary id="closed-route-title">Loop options</summary>
              <div className="advanced-content">
                <div className="range-table loop-constraint-table">
                  <div className="range-table-header" aria-hidden="true"><span>Constraint</span><span>Min</span><span>Max</span><span>Unit</span></div>
                  <div className="range-row">
                    <label className="range-label-text" htmlFor="maximum-repeated-trail" title="Maximum share of the full route that may retrace any trail">Repeated trail</label>
                    <span aria-hidden="true" />
                    <label className="range-value-cell"><span>Maximum repeated trail</span><input id="maximum-repeated-trail" aria-label="Maximum repeated trail" type="number" min="0" max="100" step="1" disabled={!settingsLoaded} value={values.maximumRepeatedTrailPct} onChange={(event) => { const maximumRepeatedTrailPct = event.currentTarget.value; setValues((current) => ({ ...current, maximumRepeatedTrailPct })); editDraft(); }} onBlur={(event) => { const maximumRepeatedTrailPct = Number(event.currentTarget.value); if (event.currentTarget.value.trim() && Number.isInteger(maximumRepeatedTrailPct) && maximumRepeatedTrailPct >= 0 && maximumRepeatedTrailPct <= 100) { changeLoopPreference({ maximumRepeatedTrailPct }); setValues((current) => ({ ...current, maximumRepeatedTrailPct: undefined })); } }} /></label>
                    <span className="range-unit-cell">%</span>
                  </div>
                  <div className="range-row">
                    <label className="range-toggle" title="Same approach trail used while leaving and returning near the trailhead">
                      <input type="checkbox" disabled={!settingsLoaded} checked={values.maximumSharedStemEnabled} onChange={(event) => changeLoopPreference({ sharedApproachEnabled: event.currentTarget.checked })} />
                      <span>Shared approach</span>
                    </label>
                    <span aria-hidden="true" />
                    <label className="range-value-cell"><span>Maximum shared approach</span><input id="maximum-shared-stem" aria-label="Maximum shared approach" type="number" min="0" max="30" step="0.1" disabled={!settingsLoaded || !values.maximumSharedStemEnabled} value={values.maximumSharedStemMiles} onChange={(event) => { const maximumSharedStemMiles = event.currentTarget.value; setValues((current) => ({ ...current, maximumSharedStemMiles })); editDraft(); }} onBlur={(event) => { const maximumSharedApproachMiles = Number(event.currentTarget.value); if (event.currentTarget.value.trim() && Number.isFinite(maximumSharedApproachMiles) && maximumSharedApproachMiles >= 0 && maximumSharedApproachMiles <= 30) { changeLoopPreference({ maximumSharedApproachMiles }); setValues((current) => ({ ...current, maximumSharedStemMiles: undefined })); } }} /></label>
                    <span className="range-unit-cell">mi</span>
                  </div>
                </div>
                <label className="switch-row">
                  <span>Allow figure-eights and chained loops</span>
                  <input type="checkbox" role="switch" disabled={!settingsLoaded} checked={values.allowMultiCycle} onChange={(event) => changeLoopPreference({ allowMultiCycle: event.currentTarget.checked })} />
                </label>
              </div>
            </details>
          </div>

          <footer className="builder-action-footer">
            {catalog && !catalog.coverages.length ? <p className="note-error" role="status">No hiking data is installed. Install regional data to search.</p> : null}
            {validationErrors.length ? <div className="validation-errors" role="alert"><strong>Check your route settings:</strong><ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
            <div className="search-count"><label htmlFor="route-count">Routes to find</label><select id="route-count" className="control" value={appSettings.quickSearchRouteCount} disabled={!settingsLoaded} onChange={(event) => { const quickSearchRouteCount = Number(event.currentTarget.value); void preferences.change((current) => ({ ...current, quickSearchRouteCount })); editDraft(); }}>{Array.from({ length: 20 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select><span>Quick search</span></div>
            <div className="builder-action-buttons">
              <button className="btn btn-primary" type="button" disabled={!ready || (workspace.status === "loading" && workspace.kind === "quick")} onClick={() => void runQuick()}>{workspace.status === "loading" && workspace.kind === "quick" ? "Searching…" : "Quick search"}</button>
              <button className="btn" type="button" disabled={!ready || batchLaunching} onClick={() => void launchBatch()}>{batchLaunching ? "Starting…" : "Full search"}</button>
            </div>
            <div className="action-legend"><span>Requested alternatives</span><span>Every eligible trailhead</span></div>
            {generationMessage ? <p className="generation-status" role="status" aria-live="polite">{generationMessage}</p> : null}
          </footer>
        </aside>
        <div className="results-panel-container" hidden={panel === "plan"}>
          {hasResultsPanel ? <ResultsPanel status={generationState === "idle" ? "done" : generationState} results={routeResults} message={generationMessage} selectedRouteId={selectedRouteId} hoveredRouteId={hoveredRouteId} selectedSegmentId={selectedSegmentId} hoveredSegmentId={hoveredSegmentId} nearMissesOpen={nearMissesOpen} onToggleNearMisses={toggleNearMisses} onSelectRoute={selectRoute} onHoverRoute={setHoveredRouteId} onSelectSegment={setSelectedSegmentId} onHoverSegment={setHoveredSegmentId} onClose={clearResults} detail={panel === "route"} onBack={() => setPanel("results")} pagination={savedResults ? { hasNext: Boolean(savedResults.nextCursor), loading: workspace.status === "loading", onNext: () => void loadJob(savedResults.job.id, savedResults.nextCursor, savedResults) } : undefined} /> : null}
        </div>
        </section>

        {catalog ? <HikeMap coverages={catalog.coverages} display={catalog.display} drawBounds={viewedRequest ? viewedRequest.area.mode === "drawn-area" ? viewedRequest.area.bbox : null : drawnBounds} filterGeometry={viewedArea?.filterGeometry ?? (!routeResults && drawnBounds ? boundsGeometry(drawnBounds) : undefined)} refinementGeometry={viewedArea?.refinementGeometry} showRegionBoundaries={appSettings.showRegionBoundaries} includeUncertainAccess={viewedRequest?.criteria.includeUncertainAccess ?? values.includeUncertainAccess} routes={mappedRoutes} selectedRouteId={selectedRouteId} hoveredRouteId={hoveredRouteId} selectedSegmentId={selectedSegmentId} hoveredSegmentId={hoveredSegmentId} onBoundsChange={changeDrawnBounds} onRouteSelect={selectRoute} onRouteHover={setHoveredRouteId} onSegmentSelect={setSelectedSegmentId} onSegmentHover={setHoveredSegmentId} /> : <div className="map-shell" role="status">{catalogError || "Loading map data…"}</div>}

        <button type="button" className="map-panel-toggle btn" aria-expanded={mapExpanded} onClick={() => setMapExpanded((current) => !current)}>{mapExpanded ? "Show panel" : "Show map"}</button>
      </div>
    </main>
  );
}
