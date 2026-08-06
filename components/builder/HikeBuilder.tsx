"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MultiPolygon, Polygon } from "geojson";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  generateClosedRoutesResponseV3Schema,
  namedAreaSchema,
  originSchema,
  reachabilityResponseSchema,
  routeJobListSchema,
  routeJobSchema,
  routeJobResultsPageSchema,
  searchRegionSummarySchema,
  type CreateBatchRouteJobV1,
  type AccessFilterV2,
  type GenerateClosedRoutesRequestV3,
  type GenerateClosedRoutesResponseV3,
  type RouteJob,
  type RouteJobResultsPage,
} from "@/lib/contracts";
import { FIXTURE_BUILDER_PACK, type BuilderPackConfig } from "@/lib/packs/fixture-pack";
import { HikeMap } from "../map/HikeMap";
import { ResultsPanel, type ResultsStatus } from "../results/ResultsPanel";
import { BoundaryEditor } from "./BoundaryEditor";
import { JobsModal } from "./JobsModal";
import { RangeInput } from "./RangeInput";
import { SettingsModal } from "./SettingsModal";
import {
  DEFAULT_BUILDER_VALUES,
  type AccessPointOption,
  type Bounds,
  type BuilderValues,
  type DriveTimeDraft,
  type RangeField,
} from "./types";
import { buildGenerateRoutesRequest } from "./validation";

type AreaGeometry = Polygon | MultiPolygon;

function boundsGeometry(bounds: Bounds): Polygon {
  const [west, south, east, north] = bounds;
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

function patchRange(setValues: React.Dispatch<React.SetStateAction<BuilderValues>>, key: keyof Pick<BuilderValues, "distanceMiles" | "elevationGainFeet" | "maximumElevationFeet" | "steepestSustainedGradePct">, next: RangeField) {
  setValues((current) => ({ ...current, [key]: next }));
}

function parseError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

function parseCoordinateOrigin(text: string) {
  const parts = text.split(/[ ,]+/).filter(Boolean).map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  const [lat, lon] = parts;
  return originSchema.safeParse({ lat, lon, label: `${lat!.toFixed(5)}, ${lon!.toFixed(5)}` });
}

function batchPageAsResponse(page: RouteJobResultsPage): GenerateClosedRoutesResponseV3 {
  const exact = page.results.filter((result) => result.matchType === "exact").map((result) => result.route);
  const nearMisses = page.results.filter((result) => result.matchType === "near-miss").map((result) => result.route);
  const progress = page.job.progress;
  return {
    version: 3,
    requestId: page.job.id,
    pack: { id: page.job.pack.id, schemaVersion: "4", dataVersion: page.job.pack.dataVersion, builtAt: page.job.pack.builtAt },
    requested: Math.max(1, Math.min(20, exact.length || 1)),
    resolvedAccessFilter: {
      mode: "drive-time",
      label: `${page.job.request.durationMinutes} minutes · ${page.job.searchRegion.name}`,
      region: page.job.searchRegion,
      driveTime: { minutes: page.job.request.durationMinutes, provider: "arcgis", resolvedAt: page.job.updatedAt, originLabel: page.job.request.origin.label },
    },
    exact,
    nearMisses,
    diagnostics: {
      elapsedMs: progress.elapsedMs,
      expandedStates: 0,
      candidateCount: progress.exactRouteCount + progress.nearMissRouteCount,
      eligibleAccessPointCount: progress.eligibleAccessPointCount,
      searchedAccessPointCount: progress.processedAccessPointCount,
      graphQueryCount: 0,
      maximumLoadedDirectedEdges: 0,
      exhausted: page.job.status === "completed",
      truncationReasons: progress.truncatedAccessPointCount > 0 ? ["per-trailhead-budget"] : [],
      shortfallReasons: [],
      noCycleAccessPointCount: 0,
      feasibleAccessPointCount: progress.eligibleAccessPointCount,
      attachmentGroupCount: 0,
      probedAttachmentGroupCount: progress.processedAccessPointCount,
      deeplySearchedAttachmentGroupCount: progress.processedAccessPointCount,
      loadedTopologyNetworkCount: 0,
      cycleBlockCount: 0,
      cyclePrimitiveCount: 0,
      composedCandidateCount: progress.exactRouteCount + progress.nearMissRouteCount,
      repairedCandidateCount: 0,
      directedValidationRejectionCount: 0,
      expandedAssemblyStates: 0,
      hardTruncationReasons: progress.truncatedAccessPointCount > 0 ? ["per-trailhead-budget"] : [],
      nonBudgetShortfallReasons: [],
    },
  };
}

export function HikeBuilder({ pack = FIXTURE_BUILDER_PACK }: { pack?: BuilderPackConfig }) {
  const [drawnBounds, setDrawnBounds] = useState<Bounds | null>(null);
  const [driveDraft, setDriveDraft] = useState<DriveTimeDraft>({
    originText: "",
    originSuggestions: [],
    durationMinutes: 30,
    state: "idle",
    searchRegionId: "",
    searchRegions: [],
    regionsState: "idle",
  });
  const [values, setValues] = useState<BuilderValues>(DEFAULT_BUILDER_VALUES);
  const [filterGeometry, setFilterGeometry] = useState<AreaGeometry>();
  const [visibleAccessPoints, setVisibleAccessPoints] = useState<AccessPointOption[]>([]);
  const trailNetwork = pack.trailNetwork;
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [generationState, setGenerationState] = useState<"idle" | ResultsStatus>("idle");
  const [generationMessage, setGenerationMessage] = useState("");
  const [generationResponse, setGenerationResponse] = useState<GenerateClosedRoutesResponseV3 | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string>();
  const [batchPage, setBatchPage] = useState<RouteJobResultsPage>();
  const [batchPageLoading, setBatchPageLoading] = useState(false);
  const [jobs, setJobs] = useState<RouteJob[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"builder" | "results">("builder");
  const [desktopBuilderVisible, setDesktopBuilderVisible] = useState(true);
  const [desktopResultsVisible, setDesktopResultsVisible] = useState(true);
  const generationControllerRef = useRef<AbortController | null>(null);
  const reachabilityControllerRef = useRef<AbortController | null>(null);
  const originRequestSequenceRef = useRef(0);

  const invalidateResults = useCallback(() => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    setGenerationState("idle");
    setGenerationMessage("");
    setGenerationResponse(null);
    setBatchPage(undefined);
    setSelectedRouteId(undefined);
  }, []);

  const updateSettings = useCallback((patch: Partial<Pick<BuilderValues, "includeUncertainAccess" | "accessPointRemoteness" | "limit">>) => {
    setValues((current) => ({ ...current, ...patch }));
    invalidateResults();
  }, [invalidateResults]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeJobs = useCallback(() => setJobsOpen(false), []);

  const displayedAccessPoints = useMemo(() => visibleAccessPoints.filter((point) =>
    values.accessPointRemoteness.includes(point.remoteness ?? "unknown")
    && (values.includeUncertainAccess || point.accessState !== "unknown")), [values.accessPointRemoteness, values.includeUncertainAccess, visibleAccessPoints]);

  useEffect(() => {
    if (pack.id === FIXTURE_BUILDER_PACK.id) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ bbox: pack.coverageBbox.join(","), includeUncertainAccess: "true", includeTrails: "false" });
    void fetch(`/api/packs/${pack.id}/access-points?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (response.ok && payload && typeof payload === "object" && "accessPoints" in payload && Array.isArray(payload.accessPoints)) setVisibleAccessPoints(payload.accessPoints as AccessPointOption[]);
      }).catch(() => undefined);
    return () => controller.abort();
  }, [pack.coverageBbox, pack.id]);

  useEffect(() => {
    if (driveDraft.regionsState !== "idle") return;
    const controller = new AbortController();
    setDriveDraft((current) => ({ ...current, regionsState: "loading" }));
    void fetch(`/api/packs/${pack.id}/search-regions`, { signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(parseError(payload, "Search regions could not be loaded."));
        const raw = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "searchRegions" in payload ? payload.searchRegions : payload && typeof payload === "object" && "regions" in payload ? payload.regions : [];
        const searchRegions = searchRegionSummarySchema.array().parse(raw).sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
        setDriveDraft((current) => ({ ...current, searchRegions, searchRegionId: current.searchRegionId || searchRegions[0]?.id || "", regionsState: "ready" }));
        if (!drawnBounds && searchRegions[0]) setFilterGeometry(boundsGeometry(searchRegions[0].bbox));
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setDriveDraft((current) => ({ ...current, regionsState: "error", error: error instanceof Error ? error.message : "Search regions could not be loaded." }));
      });
    return () => controller.abort();
  // Region loading is keyed to the active pack. Keeping the transient loading
  // state out of the dependency list prevents the request cleanup from aborting
  // itself when it marks the selector as loading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack.id]);

  useEffect(() => {
    if (driveDraft.state !== "suggesting" || driveDraft.origin || driveDraft.originText.trim().length < 2 || parseCoordinateOrigin(driveDraft.originText)?.success) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/geocoding/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId: pack.id, text: driveDraft.originText.trim() }), signal: controller.signal })
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(parseError(payload, "Origin suggestions are unavailable."));
          const originSuggestions = payload && typeof payload === "object" && "suggestions" in payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
          setDriveDraft((current) => current.originText === driveDraft.originText ? { ...current, originSuggestions, state: "idle" } : current);
        }).catch((error: unknown) => { if (!controller.signal.aborted) setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "Origin suggestions are unavailable." })); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [driveDraft.origin, driveDraft.originText, driveDraft.state, pack.id]);

  const selectOriginSuggestion = async (suggestion: { label: string; magicKey: string }) => {
    const sequence = ++originRequestSequenceRef.current;
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined, originSuggestions: [] }));
    try {
      const response = await fetch("/api/geocoding/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId: pack.id, text: suggestion.label, magicKey: suggestion.magicKey }) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "That origin could not be resolved."));
      const origin = originSchema.parse(payload && typeof payload === "object" && "origin" in payload ? payload.origin : payload);
      if (sequence !== originRequestSequenceRef.current) return;
      setDriveDraft((current) => ({ ...current, originText: origin.label, origin, state: "idle", error: undefined }));
    } catch (error) { if (sequence === originRequestSequenceRef.current) setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "That origin could not be resolved." })); }
  };

  const useTypedCoordinates = () => {
    originRequestSequenceRef.current += 1;
    const parsed = parseCoordinateOrigin(driveDraft.originText);
    if (!parsed?.success) { setDriveDraft((current) => ({ ...current, state: "error", error: "Enter coordinates as latitude, longitude." })); return; }
    setDriveDraft((current) => ({ ...current, origin: parsed.data, originText: parsed.data.label, originSuggestions: [], state: "idle", error: undefined }));
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setDriveDraft((current) => ({ ...current, state: "error", error: "Location is not available in this browser." })); return; }
    const sequence = ++originRequestSequenceRef.current;
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined }));
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (sequence !== originRequestSequenceRef.current) return;
      const origin = { lon: coords.longitude, lat: coords.latitude, label: "Current location" };
      setDriveDraft((current) => ({ ...current, origin, originText: origin.label, state: "idle" }));
    }, () => { if (sequence === originRequestSequenceRef.current) setDriveDraft((current) => ({ ...current, state: "error", error: "Location permission was denied. Type an origin or coordinates instead." })); }, { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 });
  };

  const runQuick = async () => {
    const errors: string[] = [];
    if (!drawnBounds && !driveDraft.origin) errors.push("Resolve a driving origin or draw an optional boundary.");
    if (!drawnBounds && !driveDraft.searchRegionId) errors.push("Choose a search region or draw an optional boundary.");
    if (errors.length) { setValidationErrors(errors); return; }
    generationControllerRef.current?.abort();
    reachabilityControllerRef.current?.abort();
    const controller = new AbortController();
    generationControllerRef.current = controller;
    reachabilityControllerRef.current = controller;
    setValidationErrors([]);
    setGenerationState("loading");
    setGenerationMessage(drawnBounds ? "Running Quick search inside the drawn boundary…" : "Resolving the drive-time area for Quick search…");
    setGenerationResponse(null);
    setSelectedRouteId(undefined);
    try {
      let accessFilter: AccessFilterV2;
      if (drawnBounds) {
        accessFilter = { mode: "drawn-area", bbox: drawnBounds };
      } else {
        let response = await fetch("/api/reachability", {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ version: 1, packId: pack.id, origin: driveDraft.origin, durationMinutes: driveDraft.durationMinutes }),
        });
        let payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(parseError(payload, "The drive-time area could not be calculated."));
        let parsed = reachabilityResponseSchema.parse(payload);
        while (parsed.status === "pending") {
          const { requestId, pollAfterMs } = parsed;
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(resolve, pollAfterMs);
            controller.signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
          });
          response = await fetch(`/api/reachability/${requestId}`, { signal: controller.signal });
          payload = await response.json().catch(() => null);
          if (!response.ok) throw new Error(parseError(payload, "The drive-time area could not be calculated."));
          parsed = reachabilityResponseSchema.parse(payload);
        }
        if (generationControllerRef.current !== controller) return;
        setFilterGeometry(parsed.geometry);
        accessFilter = { mode: "drive-time", reachabilityId: parsed.requestId, regionId: driveDraft.searchRegionId };
      }
      const validated = buildGenerateRoutesRequest(values, accessFilter, undefined, pack.id);
      if (!validated.success) { setValidationErrors(validated.errors); setGenerationState("idle"); return; }
      setGenerationMessage("Running Quick search…");
      if (generationControllerRef.current !== controller) return;
      const response = await fetch("/api/routes/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validated.request satisfies GenerateClosedRoutesRequestV3), signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "Routes could not be generated."));
      const parsed = generateClosedRoutesResponseV3Schema.parse(payload);
      if (generationControllerRef.current !== controller) return;
      setGenerationResponse(parsed);
      setSelectedRouteId((parsed.exact[0] ?? parsed.nearMisses[0])?.id);
      setGenerationMessage(parsed.exact.length ? `${parsed.exact.length} exact ${parsed.exact.length === 1 ? "route" : "routes"} ready.` : `No exact matches. ${parsed.nearMisses.length} near ${parsed.nearMisses.length === 1 ? "match" : "matches"} available.`);
      setGenerationState("done");
      setMobilePanel("results");
    } catch (error) {
      if (!controller.signal.aborted) { setGenerationMessage(error instanceof Error ? error.message : "Routes could not be generated."); setGenerationState("error"); }
    } finally {
      if (generationControllerRef.current === controller) generationControllerRef.current = null;
      if (reachabilityControllerRef.current === controller) reachabilityControllerRef.current = null;
    }
  };

  const launchBatch = async () => {
    const errors: string[] = [];
    if (!driveDraft.origin) errors.push("Resolve a driving origin.");
    if (!driveDraft.searchRegionId) errors.push("Choose a search region.");
    const validated = buildGenerateRoutesRequest(values, { mode: "drawn-area", bbox: pack.coverageBbox }, undefined, pack.id);
    if (!validated.success) errors.push(...validated.errors);
    if (errors.length || !driveDraft.origin || !driveDraft.searchRegionId || !validated.success) { setValidationErrors(errors); return; }
    const request = validated.request;
    const payload: CreateBatchRouteJobV1 = {
      version: 1,
      packId: pack.id,
      origin: driveDraft.origin,
      durationMinutes: driveDraft.durationMinutes,
      searchRegionId: driveDraft.searchRegionId,
      criteria: {
        closedRoute: request.closedRoute,
        distanceMiles: request.distanceMiles,
        ...(request.elevationGainFeet ? { elevationGainFeet: request.elevationGainFeet } : {}),
        ...(request.maximumElevationFeet ? { maximumElevationFeet: request.maximumElevationFeet } : {}),
        ...(request.steepestSustainedGradePct ? { steepestSustainedGradePct: request.steepestSustainedGradePct } : {}),
        includeUncertainAccess: request.includeUncertainAccess,
        accessPointRemoteness: request.accessPointRemoteness,
      },
      routesPerAccessPoint: 10,
    };
    setValidationErrors([]);
    setGenerationMessage("Launching batch search…");
    try {
      const response = await fetch("/api/route-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(raw, "Batch search could not be launched."));
      const job = routeJobSchema.parse(raw && typeof raw === "object" && "job" in raw ? raw.job : raw);
      setJobs((current) => [job, ...current.filter(({ id }) => id !== job.id)]);
      setGenerationMessage("Batch search queued. Track it in Jobs.");
      setJobsOpen(true);
    } catch (error) { setGenerationMessage(error instanceof Error ? error.message : "Batch search could not be launched."); }
  };

  const openBatchResults = useCallback((page: RouteJobResultsPage) => {
    setBatchPage(page);
    const response = batchPageAsResponse(page);
    setGenerationResponse(response);
    setGenerationState("done");
    setGenerationMessage(`${page.results.length} saved routes loaded${page.nextCursor ? "; more are available" : ""}.`);
    setSelectedRouteId((response.exact[0] ?? response.nearMisses[0])?.id);
    setJobsOpen(false);
    setMobilePanel("results");
    if (page.job.filterGeometry) {
      setFilterGeometry(page.job.filterGeometry);
      return;
    }
    const region = driveDraft.searchRegions.find(({ id }) => id === page.job.searchRegion.id);
    if (region) setFilterGeometry(boundsGeometry(region.bbox));
    void fetch(`/api/packs/${pack.id}/named-areas/${encodeURIComponent(page.job.searchRegion.id)}`)
      .then(async (response) => response.ok ? response.json() : null)
      .then((raw: unknown) => {
        const parsed = namedAreaSchema.safeParse(raw && typeof raw === "object" && "area" in raw ? raw.area : raw && typeof raw === "object" && "region" in raw ? raw.region : raw);
        if (parsed.success) setFilterGeometry(parsed.data.geometry);
      }).catch(() => undefined);
  }, [driveDraft.searchRegions, pack.id]);

  const loadNextBatchPage = async () => {
    if (!batchPage?.nextCursor) return;
    setBatchPageLoading(true);
    try {
      const query = new URLSearchParams({ limit: "50", cursor: batchPage.nextCursor });
      const response = await fetch(`/api/route-jobs/${batchPage.job.id}/results?${query}`, { cache: "no-store" });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("The next result page could not be loaded.");
      openBatchResults(routeJobResultsPageSchema.parse(raw));
    } catch (error) { setGenerationMessage(error instanceof Error ? error.message : "The next result page could not be loaded."); }
    finally { setBatchPageLoading(false); }
  };

  useEffect(() => {
    void fetch("/api/route-jobs", { cache: "no-store" }).then(async (response) => response.ok ? response.json() : null).then((raw: unknown) => {
      const parsed = routeJobListSchema.safeParse(raw);
      if (parsed.success) setJobs(parsed.data.jobs);
    }).catch(() => undefined);
    return () => { generationControllerRef.current?.abort(); reachabilityControllerRef.current?.abort(); };
  }, []);

  const generatedRoutes = useMemo(() => generationResponse ? [...generationResponse.exact, ...generationResponse.nearMisses] : [], [generationResponse]);
  const hasResultsPanel = generationState !== "idle";
  const activeJobCount = jobs.filter((job) => ["queued", "resolving-drive-time", "running"].includes(job.status)).length;
  const selectedRegion = driveDraft.searchRegions.find(({ id }) => id === driveDraft.searchRegionId);

  return (
    <main className="app-frame">
      <header className="topbar">
        <div><span className="eyebrow">Trail graph route builder</span><h1>Alpine Search</h1></div>
        <div className="pack-status" aria-label="Installed region pack"><span className="status-dot" aria-hidden="true" /><span><strong>{pack.name}</strong><small>{pack.subtitle}</small></span></div>
        <div className="topbar-actions">
          <button type="button" className="jobs-button" aria-haspopup="dialog" aria-expanded={jobsOpen} onClick={() => setJobsOpen(true)}>Jobs{activeJobCount ? ` (${activeJobCount})` : ""}</button>
          <button type="button" className="settings-button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
        <nav className="desktop-panel-controls" aria-label="Desktop panels">
          <button type="button" aria-label="Toggle plan panel" aria-pressed={desktopBuilderVisible} onClick={() => setDesktopBuilderVisible((value) => !value)}>Plan</button>
          <button type="button" aria-label="Toggle results panel" aria-pressed={desktopResultsVisible && hasResultsPanel} disabled={!hasResultsPanel} onClick={() => setDesktopResultsVisible((value) => !value)}>Results</button>
        </nav>
      </header>

      <SettingsModal open={settingsOpen} includeUncertainAccess={values.includeUncertainAccess} accessPointRemoteness={values.accessPointRemoteness} limit={values.limit} onChange={updateSettings} onClose={closeSettings} />
      <JobsModal open={jobsOpen} jobs={jobs} onJobsChange={setJobs} onOpenResults={openBatchResults} onClose={closeJobs} />

      <div className={["workspace", hasResultsPanel ? "with-results" : "", desktopBuilderVisible ? "" : "without-builder", hasResultsPanel && !desktopResultsVisible ? "without-results" : ""].filter(Boolean).join(" ")}>
        <nav className="mobile-panel-nav" aria-label="Workspace panels">
          <button type="button" aria-pressed={mobilePanel === "builder"} onClick={() => setMobilePanel("builder")}>Plan</button>
          <button type="button" aria-pressed={mobilePanel === "results"} disabled={!hasResultsPanel} onClick={() => setMobilePanel("results")}>Results{generationResponse ? ` (${generatedRoutes.length})` : ""}</button>
        </nav>
        <aside className={["builder-panel", mobilePanel === "builder" ? "" : "mobile-panel-hidden", desktopBuilderVisible ? "" : "desktop-panel-hidden"].filter(Boolean).join(" ")} aria-labelledby="builder-title">
          <div className="panel-heading builder-console-heading"><div className="builder-console-title"><h2 id="builder-title">Build your route</h2></div><span className="builder-console-badge">Quick or batch</span></div>

          <section className="builder-section filter-section" aria-labelledby="search-area-title">
            <div className="section-title"><h3 id="search-area-title">Where to search</h3><span>Shared</span></div>
            <div className="drive-filter-editor">
              <p className="filter-explainer">Choose one location, drive time, and broad region. Quick and Batch use the same criteria.</p>
              <label htmlFor="drive-origin">Driving origin</label>
              <div className="input-with-action"><input id="drive-origin" type="search" value={driveDraft.originText} autoComplete="off" placeholder="Address, place, or latitude, longitude" onChange={(event) => { const originText = event.currentTarget.value; originRequestSequenceRef.current += 1; reachabilityControllerRef.current?.abort(); setDriveDraft((current) => ({ ...current, originText, origin: current.origin?.label === originText ? current.origin : undefined, originSuggestions: [], state: "suggesting", error: undefined })); invalidateResults(); }} /><button type="button" onClick={useTypedCoordinates}>Use coordinates</button></div>
              {driveDraft.originSuggestions.length ? <ul className="suggestion-list" role="listbox" aria-label="Origin suggestions">{driveDraft.originSuggestions.map((suggestion) => <li key={suggestion.id}><button type="button" role="option" aria-selected="false" onClick={() => void selectOriginSuggestion(suggestion)}><strong>{suggestion.label}</strong></button></li>)}</ul> : null}
              <button className="location-button" type="button" onClick={useCurrentLocation}>Use my current location</button>
              {driveDraft.origin ? <p className="selection-chip"><span aria-hidden="true">✓</span><strong>{driveDraft.origin.label}</strong><small>{driveDraft.origin.lat.toFixed(5)}, {driveDraft.origin.lon.toFixed(5)}</small></p> : null}
              <label className="select-field" htmlFor="drive-duration">Typical drive time<select id="drive-duration" value={driveDraft.durationMinutes} onChange={(event) => { reachabilityControllerRef.current?.abort(); setDriveDraft((current) => ({ ...current, durationMinutes: Number(event.currentTarget.value) })); invalidateResults(); }}>{DRIVE_TIME_DURATIONS_MINUTES.map((minutes) => <option value={minutes} key={minutes}>{minutes} minutes</option>)}</select></label>
              <label className="select-field" htmlFor="search-region">Broad region<select id="search-region" value={driveDraft.searchRegionId} disabled={driveDraft.regionsState === "loading"} onChange={(event) => { const searchRegionId = event.currentTarget.value; const region = driveDraft.searchRegions.find(({ id }) => id === searchRegionId); reachabilityControllerRef.current?.abort(); setDriveDraft((current) => ({ ...current, searchRegionId })); if (!drawnBounds) setFilterGeometry(region ? boundsGeometry(region.bbox) : undefined); invalidateResults(); }}><option value="">Choose a region</option>{driveDraft.searchRegions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label>
              {driveDraft.regionsState === "loading" ? <p className="inline-status" role="status">Loading curated regions…</p> : null}
              {selectedRegion ? <p className="selection-chip"><span aria-hidden="true">✓</span><strong>{selectedRegion.name}</strong><small>{selectedRegion.kind.replaceAll("-", " ")}</small></p> : null}
              {driveDraft.error ? <p className="error-state" role="alert">{driveDraft.error}</p> : null}
              <p className="provider-note">Typical/static drive time; live traffic is not used. Batch jobs retain their origin until deletion.</p>
            </div>
          </section>

          <section className="builder-section optional-boundary" aria-labelledby="boundary-title">
            <div className="section-title"><h3 id="boundary-title">Drawn boundary</h3><span>Optional Quick override</span></div>
            <p>Draw on the map or enter coordinates to make Quick search use that area instead of drive time. Batch always uses the origin, drive time, and region above.</p>
            <BoundaryEditor key={drawnBounds?.join(",") ?? "empty"} bounds={drawnBounds} onChange={(bounds) => { setDrawnBounds(bounds); setFilterGeometry(bounds ? boundsGeometry(bounds) : selectedRegion ? boundsGeometry(selectedRegion.bbox) : undefined); invalidateResults(); }} />
            {drawnBounds ? <output className="boundary-summary complete"><span aria-hidden="true">✓</span>{drawnBounds.map((value) => value.toFixed(4)).join(", ")}</output> : <p className="empty-state">No Quick-search boundary drawn.</p>}
          </section>

          <section className="builder-section" aria-labelledby="closed-route-title"><div className="section-title"><h3 id="closed-route-title">Closed route</h3><span>Start and finish together</span></div><p className="filter-explainer">Closed routes start and finish at the same trailhead. The repetition control limits how much trail is walked twice.</p><div className="count-field"><label htmlFor="maximum-repeated-trail">Maximum repeated trail</label><input id="maximum-repeated-trail" type="range" min="0" max="100" step="1" value={values.maximumRepeatedTrailPct} aria-valuetext={`${values.maximumRepeatedTrailPct}%`} onChange={(event) => { setValues((current) => ({ ...current, maximumRepeatedTrailPct: event.currentTarget.value })); invalidateResults(); }} /><output htmlFor="maximum-repeated-trail">{values.maximumRepeatedTrailPct}%</output><small>0% allows only routes with no repeated trail.</small></div><label className="switch-row"><span><strong>Limit the shared access stem</strong><small>Optional one-way distance before the loop begins.</small></span><input type="checkbox" role="switch" checked={values.maximumSharedStemEnabled} onChange={(event) => { setValues((current) => ({ ...current, maximumSharedStemEnabled: event.currentTarget.checked })); invalidateResults(); }} /></label>{values.maximumSharedStemEnabled ? <div className="count-field"><label htmlFor="maximum-shared-stem">Maximum shared stem</label><input id="maximum-shared-stem" type="number" min="0" max="30" step="0.1" value={values.maximumSharedStemMiles} onChange={(event) => { setValues((current) => ({ ...current, maximumSharedStemMiles: event.currentTarget.value })); invalidateResults(); }} /><small>Miles, one way (0 to 30)</small></div> : null}<label className="switch-row"><span><strong>Allow figure-eights and chained loops</strong><small>On by default. Turn off to require exactly one cycle.</small></span><input type="checkbox" role="switch" checked={values.allowMultiCycle} onChange={(event) => { setValues((current) => ({ ...current, allowMultiCycle: event.currentTarget.checked })); invalidateResults(); }} /></label></section>

          <section className="builder-section constraints" aria-labelledby="constraints-title"><div className="section-title"><h3 id="constraints-title">Physical constraints</h3><span>Min – max</span></div><div className="range-table"><div className="range-table-header" aria-hidden="true"><span>Constraint</span><span>Minimum</span><span>Maximum</span><span>Unit</span></div><RangeInput id="distance" label="Distance" unit="miles (max 30)" optional={false} value={values.distanceMiles} onChange={(next) => { patchRange(setValues, "distanceMiles", next); invalidateResults(); }} /><RangeInput id="gain" label="Elevation gain" unit="feet" value={values.elevationGainFeet} onChange={(next) => { patchRange(setValues, "elevationGainFeet", next); invalidateResults(); }} /><RangeInput id="altitude" label="Maximum elevation" unit="feet" value={values.maximumElevationFeet} onChange={(next) => { patchRange(setValues, "maximumElevationFeet", next); invalidateResults(); }} /><RangeInput id="grade" label="Steepest sustained grade" unit="% over 100 m" value={values.steepestSustainedGradePct} onChange={(next) => { patchRange(setValues, "steepestSustainedGradePct", next); invalidateResults(); }} /></div></section>

          <footer className="builder-action-footer">{validationErrors.length ? <div className="validation-errors" role="alert"><strong>Check your route settings:</strong><ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}<div className="builder-action-buttons unified-actions"><button className="quick-button" type="button" disabled={generationState === "loading"} onClick={() => void runQuick()}>{generationState === "loading" ? "Searching…" : "Quick search"}</button><button className="generate-button" type="button" onClick={() => void launchBatch()}>Batch search</button></div>{generationMessage ? <p className="generation-status" role="status" aria-live="polite">{generationMessage}</p> : null}</footer>
        </aside>

        <HikeMap drawBounds={drawnBounds} drawEnabled filterGeometry={filterGeometry} packCoverageBbox={pack.coverageBbox} packCoverage={pack.coverage} suggestedBounds={pack.suggestedBounds} display={pack.display} trailNetwork={trailNetwork} accessPoints={displayedAccessPoints} routes={generatedRoutes} selectedRouteId={selectedRouteId} onBoundsChange={(bounds) => { setDrawnBounds(bounds); setFilterGeometry(bounds ? boundsGeometry(bounds) : selectedRegion ? boundsGeometry(selectedRegion.bbox) : undefined); invalidateResults(); }} onAccessPointSelect={() => undefined} onRouteSelect={setSelectedRouteId} />
        {hasResultsPanel ? <ResultsPanel status={generationState as ResultsStatus} response={generationResponse} message={generationMessage} selectedRouteId={selectedRouteId} onSelectRoute={setSelectedRouteId} mobileVisible={mobilePanel === "results"} desktopVisible={desktopResultsVisible} pagination={batchPage ? { hasNext: Boolean(batchPage.nextCursor), loading: batchPageLoading, onNext: () => void loadNextBatchPage() } : undefined} /> : null}
      </div>
    </main>
  );
}
