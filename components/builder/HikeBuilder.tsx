"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  generateClosedRoutesResponseV3Schema,
  namedAreaSchema,
  originSchema,
  routeJobListSchema,
  routeJobSchema,
  routeJobResultsPageSchema,
  searchRegionSummarySchema,
  type CreateBatchRouteJobV1,
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
  type FilterMode,
  type RangeField,
} from "./types";
import { buildGenerateRoutesRequest } from "./validation";

type AreaGeometry = Polygon | MultiPolygon;

const MODES: Array<{ id: FilterMode; label: string; help: string }> = [
  { id: "explore", label: "Explore", help: "Draw an area for a quick live search." },
  { id: "batch", label: "Batch search", help: "Search every eligible trailhead in a drive-time region." },
];

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

function isTrailNetwork(value: unknown): value is FeatureCollection<LineString> {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "FeatureCollection" && Array.isArray((value as { features?: unknown }).features));
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
  const [mode, setMode] = useState<FilterMode>("explore");
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
  const [accessPoints, setAccessPoints] = useState<AccessPointOption[]>([]);
  const [visibleAccessPoints, setVisibleAccessPoints] = useState<AccessPointOption[]>([]);
  const [trailNetwork, setTrailNetwork] = useState<FeatureCollection<LineString>>(pack.trailNetwork);
  const [selectedAccessPointId, setSelectedAccessPointId] = useState<string>();
  const [accessState, setAccessState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [accessError, setAccessError] = useState("");
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
  const previewControllerRef = useRef<AbortController | null>(null);
  const eligibleAccessPointsRef = useRef(accessPoints);

  useEffect(() => { eligibleAccessPointsRef.current = accessPoints; }, [accessPoints]);

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

  const activeAccessFilter = useMemo(() => mode === "explore" && drawnBounds
    ? { mode: "drawn-area" as const, bbox: drawnBounds }
    : null, [drawnBounds, mode]);

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
    if (mode !== "batch" || driveDraft.regionsState !== "idle") return;
    const controller = new AbortController();
    setDriveDraft((current) => ({ ...current, regionsState: "loading" }));
    void fetch(`/api/packs/${pack.id}/search-regions`, { signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(parseError(payload, "Search regions could not be loaded."));
        const raw = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "searchRegions" in payload ? payload.searchRegions : payload && typeof payload === "object" && "regions" in payload ? payload.regions : [];
        const searchRegions = searchRegionSummarySchema.array().parse(raw).sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
        setDriveDraft((current) => ({ ...current, searchRegions, searchRegionId: current.searchRegionId || searchRegions[0]?.id || "", regionsState: "ready" }));
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setDriveDraft((current) => ({ ...current, regionsState: "error", error: error instanceof Error ? error.message : "Search regions could not be loaded." }));
      });
    return () => controller.abort();
  // Region loading is keyed to entering Batch mode. Keeping the transient
  // loading state out of the dependency list prevents the request cleanup from
  // aborting itself when it marks the selector as loading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pack.id]);

  useEffect(() => {
    if (mode !== "batch" || driveDraft.state !== "suggesting" || driveDraft.origin || driveDraft.originText.trim().length < 2 || parseCoordinateOrigin(driveDraft.originText)?.success) return;
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
  }, [driveDraft.origin, driveDraft.originText, driveDraft.state, mode, pack.id]);

  const selectOriginSuggestion = async (suggestion: { label: string; magicKey: string }) => {
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined, originSuggestions: [] }));
    try {
      const response = await fetch("/api/geocoding/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId: pack.id, text: suggestion.label, magicKey: suggestion.magicKey }) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "That origin could not be resolved."));
      const origin = originSchema.parse(payload && typeof payload === "object" && "origin" in payload ? payload.origin : payload);
      setDriveDraft((current) => ({ ...current, originText: origin.label, origin, state: "idle", error: undefined }));
    } catch (error) { setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "That origin could not be resolved." })); }
  };

  const useTypedCoordinates = () => {
    const parsed = parseCoordinateOrigin(driveDraft.originText);
    if (!parsed?.success) { setDriveDraft((current) => ({ ...current, state: "error", error: "Enter coordinates as latitude, longitude." })); return; }
    setDriveDraft((current) => ({ ...current, origin: parsed.data, originText: parsed.data.label, originSuggestions: [], state: "idle", error: undefined }));
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setDriveDraft((current) => ({ ...current, state: "error", error: "Location is not available in this browser." })); return; }
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined }));
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      const origin = { lon: coords.longitude, lat: coords.latitude, label: "Current location" };
      setDriveDraft((current) => ({ ...current, origin, originText: origin.label, state: "idle" }));
    }, () => setDriveDraft((current) => ({ ...current, state: "error", error: "Location permission was denied. Type an origin or coordinates instead." })), { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 });
  };

  useEffect(() => {
    previewControllerRef.current?.abort();
    setAccessPoints([]);
    setSelectedAccessPointId(undefined);
    if (!activeAccessFilter) { setAccessState("idle"); return; }
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setAccessState("loading");
    setAccessError("");
    void fetch(`/api/packs/${pack.id}/access-points/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ accessFilter: activeAccessFilter, includeUncertainAccess: values.includeUncertainAccess, accessPointRemoteness: values.accessPointRemoteness }),
    }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "Eligible access points could not be loaded."));
      if (!payload || typeof payload !== "object" || !("accessPoints" in payload) || !Array.isArray(payload.accessPoints)) throw new Error("Access-point preview data was invalid.");
      setAccessPoints(payload.accessPoints as AccessPointOption[]);
      if ("filterGeometry" in payload && payload.filterGeometry) setFilterGeometry(payload.filterGeometry as AreaGeometry);
      if ("trailNetwork" in payload && isTrailNetwork(payload.trailNetwork)) setTrailNetwork(payload.trailNetwork);
      setAccessState("ready");
    }).catch((error: unknown) => { if (!controller.signal.aborted) { setAccessState("error"); setAccessError(error instanceof Error ? error.message : "Eligible access points could not be loaded."); } });
    return () => controller.abort();
  }, [activeAccessFilter, pack.id, values.accessPointRemoteness, values.includeUncertainAccess]);

  const runExplore = useCallback(async (request: GenerateClosedRoutesRequestV3) => {
    generationControllerRef.current?.abort();
    const controller = new AbortController();
    generationControllerRef.current = controller;
    setValidationErrors([]);
    setGenerationState("loading");
    setGenerationMessage("Quick search is updating…");
    try {
      const response = await fetch("/api/routes/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
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
    } finally { if (generationControllerRef.current === controller) generationControllerRef.current = null; }
  }, []);

  useEffect(() => {
    if (mode !== "explore") return;
    const validated = buildGenerateRoutesRequest(values, activeAccessFilter, selectedAccessPointId, pack.id);
    if (!validated.success) { generationControllerRef.current?.abort(); setGenerationState("idle"); setGenerationResponse(null); return; }
    const timer = window.setTimeout(() => void runExplore(validated.request), 600);
    return () => { window.clearTimeout(timer); generationControllerRef.current?.abort(); };
  }, [activeAccessFilter, mode, pack.id, runExplore, selectedAccessPointId, values]);

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
    setMode("batch");
    setJobsOpen(false);
    setMobilePanel("results");
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
    return () => { generationControllerRef.current?.abort(); previewControllerRef.current?.abort(); };
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
          <div className="panel-heading builder-console-heading"><div className="builder-console-title"><h2 id="builder-title">Build your route</h2></div><span className="builder-console-badge">{mode === "explore" ? "Live search" : "Background job"}</span></div>

          <section className="builder-section filter-section" aria-labelledby="mode-title">
            <div className="section-title"><h3 id="mode-title">Search mode</h3><span>Required</span></div>
            <div className="filter-mode-tabs two-mode-tabs" role="radiogroup" aria-label="Route builder mode">
              {MODES.map((item) => <label key={item.id} className={mode === item.id ? "selected" : ""}><input type="radio" name="builder-mode" checked={mode === item.id} onChange={() => { if (mode !== item.id) { generationControllerRef.current?.abort(); setMode(item.id); setAccessPoints([]); setSelectedAccessPointId(undefined); setFilterGeometry(item.id === "explore" && drawnBounds ? boundsGeometry(drawnBounds) : undefined); invalidateResults(); } }} /><strong>{item.label}</strong><small>{item.help}</small></label>)}
            </div>
            {mode === "explore" ? <div className="filter-editor"><p className="filter-explainer">Drawn areas filter trailheads, not route geometry. Valid changes search automatically after 600 ms.</p><BoundaryEditor key={drawnBounds?.join(",") ?? "empty"} bounds={drawnBounds} onChange={(bounds) => { setDrawnBounds(bounds); setFilterGeometry(bounds ? boundsGeometry(bounds) : undefined); setAccessPoints([]); setSelectedAccessPointId(undefined); invalidateResults(); }} />{drawnBounds ? <output className="boundary-summary complete"><span aria-hidden="true">✓</span>{drawnBounds.map((value) => value.toFixed(4)).join(", ")}</output> : <p className="empty-state">Draw an area on the map or enter coordinates.</p>}</div> : (
              <div className="drive-filter-editor">
                <p className="filter-explainer">A persistent background job searches every eligible trailhead in the drive-time and region intersection.</p>
                <label htmlFor="drive-origin">Driving origin</label>
                <div className="input-with-action"><input id="drive-origin" type="search" value={driveDraft.originText} autoComplete="off" placeholder="Address, place, or latitude, longitude" onChange={(event) => { const originText = event.currentTarget.value; setDriveDraft((current) => ({ ...current, originText, origin: current.origin?.label === originText ? current.origin : undefined, originSuggestions: [], state: "suggesting", error: undefined })); }} /><button type="button" onClick={useTypedCoordinates}>Use coordinates</button></div>
                {driveDraft.originSuggestions.length ? <ul className="suggestion-list" role="listbox" aria-label="Origin suggestions">{driveDraft.originSuggestions.map((suggestion) => <li key={suggestion.id}><button type="button" role="option" aria-selected="false" onClick={() => void selectOriginSuggestion(suggestion)}><strong>{suggestion.label}</strong></button></li>)}</ul> : null}
                <button className="location-button" type="button" onClick={useCurrentLocation}>Use my current location</button>
                {driveDraft.origin ? <p className="selection-chip"><span aria-hidden="true">✓</span><strong>{driveDraft.origin.label}</strong><small>{driveDraft.origin.lat.toFixed(5)}, {driveDraft.origin.lon.toFixed(5)}</small></p> : null}
                <label className="select-field" htmlFor="drive-duration">Typical drive time<select id="drive-duration" value={driveDraft.durationMinutes} onChange={(event) => setDriveDraft((current) => ({ ...current, durationMinutes: Number(event.currentTarget.value) }))}>{DRIVE_TIME_DURATIONS_MINUTES.map((minutes) => <option value={minutes} key={minutes}>{minutes} minutes</option>)}</select></label>
                <label className="select-field" htmlFor="search-region">Search region<select id="search-region" value={driveDraft.searchRegionId} disabled={driveDraft.regionsState === "loading"} onChange={(event) => { const searchRegionId = event.currentTarget.value; const region = driveDraft.searchRegions.find(({ id }) => id === searchRegionId); setDriveDraft((current) => ({ ...current, searchRegionId })); setFilterGeometry(region ? boundsGeometry(region.bbox) : undefined); }}><option value="">Choose a region</option>{driveDraft.searchRegions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label>
                {driveDraft.regionsState === "loading" ? <p className="inline-status" role="status">Loading curated regions…</p> : null}
                {selectedRegion ? <p className="selection-chip"><span aria-hidden="true">✓</span><strong>{selectedRegion.name}</strong><small>{selectedRegion.kind.replaceAll("-", " ")}</small></p> : null}
                {driveDraft.error ? <p className="error-state" role="alert">{driveDraft.error}</p> : null}
                <p className="provider-note">Typical/static drive time; live traffic is not used. The origin is stored with this local job until deletion.</p>
              </div>
            )}
          </section>

          {mode === "explore" ? <section className="builder-section" aria-labelledby="access-title"><div className="section-title"><h3 id="access-title">Starting access point</h3><span>Optional</span></div><p>Choose an eligible trailhead, or search automatically.</p>{!activeAccessFilter ? <p className="empty-state">Draw an area to preview eligible access.</p> : null}{accessState === "loading" ? <p className="loading-state" role="status">Finding eligible access points…</p> : null}{accessState === "error" ? <p className="error-state" role="alert">{accessError}</p> : null}{activeAccessFilter && accessState === "ready" && accessPoints.length === 0 ? <p className="empty-state" role="status">No eligible access points match this area.</p> : null}{accessPoints.length ? <label className="select-field" htmlFor="access-point">Access point<select id="access-point" value={selectedAccessPointId ?? ""} onChange={(event) => { setSelectedAccessPointId(event.currentTarget.value || undefined); invalidateResults(); }}><option value="">Choose automatically</option>{accessPoints.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label> : null}</section> : null}

          <section className="builder-section" aria-labelledby="closed-route-title"><div className="section-title"><h3 id="closed-route-title">Closed route</h3><span>Start and finish together</span></div><p className="filter-explainer">Closed routes start and finish at the same trailhead. The repetition control limits how much trail is walked twice.</p><div className="count-field"><label htmlFor="maximum-repeated-trail">Maximum repeated trail</label><input id="maximum-repeated-trail" type="range" min="0" max="100" step="1" value={values.maximumRepeatedTrailPct} aria-valuetext={`${values.maximumRepeatedTrailPct}%`} onChange={(event) => { setValues((current) => ({ ...current, maximumRepeatedTrailPct: event.currentTarget.value })); invalidateResults(); }} /><output htmlFor="maximum-repeated-trail">{values.maximumRepeatedTrailPct}%</output><small>0% allows only routes with no repeated trail.</small></div><label className="switch-row"><span><strong>Limit the shared access stem</strong><small>Optional one-way distance before the loop begins.</small></span><input type="checkbox" role="switch" checked={values.maximumSharedStemEnabled} onChange={(event) => { setValues((current) => ({ ...current, maximumSharedStemEnabled: event.currentTarget.checked })); invalidateResults(); }} /></label>{values.maximumSharedStemEnabled ? <div className="count-field"><label htmlFor="maximum-shared-stem">Maximum shared stem</label><input id="maximum-shared-stem" type="number" min="0" max="30" step="0.1" value={values.maximumSharedStemMiles} onChange={(event) => { setValues((current) => ({ ...current, maximumSharedStemMiles: event.currentTarget.value })); invalidateResults(); }} /><small>Miles, one way (0 to 30)</small></div> : null}<label className="switch-row"><span><strong>Allow figure-eights and chained loops</strong><small>On by default. Turn off to require exactly one cycle.</small></span><input type="checkbox" role="switch" checked={values.allowMultiCycle} onChange={(event) => { setValues((current) => ({ ...current, allowMultiCycle: event.currentTarget.checked })); invalidateResults(); }} /></label></section>

          <section className="builder-section constraints" aria-labelledby="constraints-title"><div className="section-title"><h3 id="constraints-title">Physical constraints</h3><span>Min – max</span></div><div className="range-table"><div className="range-table-header" aria-hidden="true"><span>Constraint</span><span>Minimum</span><span>Maximum</span><span>Unit</span></div><RangeInput id="distance" label="Distance" unit="miles (max 30)" optional={false} value={values.distanceMiles} onChange={(next) => { patchRange(setValues, "distanceMiles", next); invalidateResults(); }} /><RangeInput id="gain" label="Elevation gain" unit="feet" value={values.elevationGainFeet} onChange={(next) => { patchRange(setValues, "elevationGainFeet", next); invalidateResults(); }} /><RangeInput id="altitude" label="Maximum elevation" unit="feet" value={values.maximumElevationFeet} onChange={(next) => { patchRange(setValues, "maximumElevationFeet", next); invalidateResults(); }} /><RangeInput id="grade" label="Steepest sustained grade" unit="% over 100 m" value={values.steepestSustainedGradePct} onChange={(next) => { patchRange(setValues, "steepestSustainedGradePct", next); invalidateResults(); }} /></div></section>

          <footer className="builder-action-footer">{validationErrors.length ? <div className="validation-errors" role="alert"><strong>Check your route settings:</strong><ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}{mode === "batch" ? <div className="builder-action-buttons"><button className="generate-button" type="button" onClick={() => void launchBatch()}>Launch batch search</button></div> : <p className="auto-search-note">Explore searches automatically when the area or criteria change.</p>}{generationMessage ? <p className="generation-status" role="status" aria-live="polite">{generationMessage}</p> : null}</footer>
        </aside>

        <HikeMap mode={mode} drawBounds={drawnBounds} drawEnabled={mode === "explore"} filterGeometry={filterGeometry} packCoverageBbox={pack.coverageBbox} packCoverage={pack.coverage} suggestedBounds={pack.suggestedBounds} display={pack.display} trailNetwork={trailNetwork} accessPoints={displayedAccessPoints} selectedAccessPointId={mode === "explore" ? selectedAccessPointId : undefined} routes={generatedRoutes} selectedRouteId={selectedRouteId} onBoundsChange={(bounds) => { if (mode === "explore") { setDrawnBounds(bounds); setFilterGeometry(bounds ? boundsGeometry(bounds) : undefined); invalidateResults(); } }} onAccessPointSelect={(id) => { if (mode === "explore" && eligibleAccessPointsRef.current.some((point) => point.id === id)) { setSelectedAccessPointId(id); invalidateResults(); } }} onRouteSelect={setSelectedRouteId} />
        {hasResultsPanel ? <ResultsPanel status={generationState as ResultsStatus} response={generationResponse} message={generationMessage} selectedRouteId={selectedRouteId} onSelectRoute={setSelectedRouteId} mobileVisible={mobilePanel === "results"} desktopVisible={desktopResultsVisible} pagination={batchPage ? { hasNext: Boolean(batchPage.nextCursor), loading: batchPageLoading, onNext: () => void loadNextBatchPage() } : undefined} /> : null}
      </div>
    </main>
  );
}
