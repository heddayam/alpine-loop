"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MultiPolygon, Polygon } from "geojson";
import { useRouter } from "next/navigation";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  appSettingsV1Schema,
  generateClosedRoutesResponseV3Schema,
  namedAreaSchema,
  originSchema,
  packCatalogRegionV1Schema,
  reachabilityResponseSchema,
  routeJobListSchema,
  routeJobSchema,
  routeJobResultsPageSchema,
  searchRegionSummarySchema,
  type CreateBatchRouteJobV1,
  type AppSettingsV1,
  type GradePresetId,
  type PackCatalogRegionV1,
  type AccessFilterV2,
  type GenerateClosedRoutesRequestV3,
  type GenerateClosedRoutesResponseV3,
  type RouteJob,
  type RouteJobResultsPage,
} from "@/lib/contracts";
import { FIXTURE_BUILDER_PACK, type BuilderPackConfig } from "@/lib/packs/fixture-pack";
import { HikeMap } from "../map/HikeMap";
import { ResultsPanel, type ResultsStatus } from "../results/ResultsPanel";
import { JobsModal, type JobsLoadState } from "./JobsModal";
import { GradePresetInput } from "./GradePresetInput";
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
const ACTIVE_JOB_STATUSES = new Set<RouteJob["status"]>(["queued", "resolving-drive-time", "running"]);
const JOB_POLL_OPEN_MS = 2_000;
const JOB_POLL_CLOSED_MS = 5_000;

const FIXTURE_REGION: PackCatalogRegionV1 = packCatalogRegionV1Schema.parse({
  id: "santa-cruz-mountains",
  label: "Santa Cruz Mountains",
  displayOrder: 1,
  state: "available",
  packId: FIXTURE_BUILDER_PACK.id,
  pack: {
    id: FIXTURE_BUILDER_PACK.id,
    name: FIXTURE_BUILDER_PACK.name,
    dataVersion: FIXTURE_BUILDER_PACK.dataVersion,
    builtAt: FIXTURE_BUILDER_PACK.builtAt,
    coverageBbox: FIXTURE_BUILDER_PACK.coverageBbox,
    coverage: FIXTURE_BUILDER_PACK.coverage,
    display: FIXTURE_BUILDER_PACK.display,
  },
});

function boundsGeometry(bounds: Bounds): Polygon {
  const [west, south, east, north] = bounds;
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

function patchRange(setValues: React.Dispatch<React.SetStateAction<BuilderValues>>, key: keyof Pick<BuilderValues, "distanceMiles" | "elevationGainFeet" | "maximumElevationFeet">, next: RangeField) {
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

export function HikeBuilder({
  pack = FIXTURE_BUILDER_PACK,
  regions = [FIXTURE_REGION],
  restoreJobId,
}: {
  pack?: BuilderPackConfig;
  regions?: PackCatalogRegionV1[];
  restoreJobId?: string;
}) {
  const router = useRouter();
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
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>();
  const [hoveredSegmentId, setHoveredSegmentId] = useState<string>();
  const [batchPage, setBatchPage] = useState<RouteJobResultsPage>();
  const [batchPageLoading, setBatchPageLoading] = useState(false);
  const [jobs, setJobs] = useState<RouteJob[]>([]);
  const [jobsLoadState, setJobsLoadState] = useState<JobsLoadState>("loading");
  const [jobsLoadError, setJobsLoadError] = useState<string>();
  const [jobsRefreshedAt, setJobsRefreshedAt] = useState<number>();
  const [jobsAnnouncement, setJobsAnnouncement] = useState("");
  const [jobsOpen, setJobsOpen] = useState(false);
  const [batchLaunching, setBatchLaunching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [hoveredRouteId, setHoveredRouteId] = useState<string>();
  const [nearMissesOpen, setNearMissesOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"builder" | "results">("builder");
  const [desktopBuilderVisible, setDesktopBuilderVisible] = useState(true);
  const [desktopResultsVisible, setDesktopResultsVisible] = useState(true);
  const generationControllerRef = useRef<AbortController | null>(null);
  const reachabilityControllerRef = useRef<AbortController | null>(null);
  const originRequestSequenceRef = useRef(0);
  const jobsRef = useRef<RouteJob[]>([]);
  const jobsLoadedRef = useRef(false);
  const jobsRefreshControllerRef = useRef<AbortController | null>(null);
  const jobsRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const jobsRefreshGenerationRef = useRef(0);
  const batchLaunchInFlightRef = useRef(false);
  const restoredJobRef = useRef<string | undefined>(undefined);

  const orderedRegions = useMemo(
    () => [...regions].sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label)),
    [regions],
  );
  const availablePackIds = useMemo(
    () => new Set(orderedRegions.flatMap((region) => region.state === "available" ? [region.packId] : [])),
    [orderedRegions],
  );

  const switchPack = useCallback((packId: string, jobId?: string) => {
    const query = new URLSearchParams({ pack: packId });
    if (jobId) query.set("job", jobId);
    router.push(`/?${query}`);
  }, [router]);

  const acceptJobs = useCallback((next: RouteJob[], refreshedAt: number, announceTransitions = true) => {
    if (announceTransitions && jobsLoadedRef.current) {
      const previousById = new Map(jobsRef.current.map((job) => [job.id, job]));
      const finished = next.find((job) => {
        const previous = previousById.get(job.id);
        return previous && ACTIVE_JOB_STATUSES.has(previous.status) && ["completed", "cancelled", "failed"].includes(job.status);
      });
      if (finished) {
        const message = finished.status === "completed"
          ? `${finished.searchRegion.name} batch search complete. Open Jobs to view results.`
          : finished.status === "cancelled"
            ? `${finished.searchRegion.name} batch search cancelled.`
            : `${finished.searchRegion.name} batch search failed. Open Jobs for details.`;
        setJobsAnnouncement(message);
      }
    }
    jobsRef.current = next;
    jobsLoadedRef.current = true;
    setJobs(next);
    setJobsRefreshedAt(refreshedAt);
    setJobsLoadState("ready");
    setJobsLoadError(undefined);
  }, []);

  const refreshJobs = useCallback(async (abortStale = false): Promise<void> => {
    const existing = jobsRefreshPromiseRef.current;
    if (existing) {
      if (!abortStale) return existing;
      const existingController = jobsRefreshControllerRef.current;
      existingController?.abort();
      await existing;
      if (jobsRefreshPromiseRef.current === existing) jobsRefreshPromiseRef.current = null;
      if (jobsRefreshControllerRef.current === existingController) jobsRefreshControllerRef.current = null;
    }
    if (jobsRefreshPromiseRef.current) return jobsRefreshPromiseRef.current;
    const controller = new AbortController();
    const generation = ++jobsRefreshGenerationRef.current;
    jobsRefreshControllerRef.current = controller;
    const request = (async () => {
      try {
        const response = await fetch("/api/route-jobs", { cache: "no-store", signal: controller.signal });
        const raw: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error("Jobs could not be refreshed.");
        const parsed = routeJobListSchema.parse(raw);
        if (!controller.signal.aborted && jobsRefreshGenerationRef.current === generation) acceptJobs(parsed.jobs, Date.now());
      } catch (error) {
        if (!controller.signal.aborted && jobsRefreshGenerationRef.current === generation) {
          setJobsLoadState("error");
          setJobsLoadError(error instanceof Error ? error.message : "Jobs could not be refreshed.");
        }
      }
    })();
    jobsRefreshPromiseRef.current = request;
    try { await request; }
    finally {
      if (jobsRefreshPromiseRef.current === request) jobsRefreshPromiseRef.current = null;
      if (jobsRefreshControllerRef.current === controller) jobsRefreshControllerRef.current = null;
    }
  }, [acceptJobs]);

  const invalidateResults = useCallback(() => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    setGenerationState("idle");
    setGenerationMessage("");
    setGenerationResponse(null);
    setBatchPage(undefined);
    setSelectedRouteId(undefined);
    setSelectedSegmentId(undefined);
    setHoveredSegmentId(undefined);
  }, []);

  const selectRoute = useCallback((routeId: string) => {
    setSelectedRouteId(routeId);
    setSelectedSegmentId(undefined);
    setHoveredSegmentId(undefined);
  }, []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeJobs = useCallback(() => setJobsOpen(false), []);

  const displayedAccessPoints = useMemo(() => visibleAccessPoints.filter((point) =>
    values.includeUncertainAccess || point.accessState !== "unknown"), [values.includeUncertainAccess, visibleAccessPoints]);

  const appSettings = useMemo<AppSettingsV1>(() => ({
    schemaVersion: 1,
    includeUncertainAccess: values.includeUncertainAccess,
    quickSearchRouteCount: Number(values.limit),
    gradeConstraintEnabled: values.gradeConstraintEnabled,
    selectedGradePreset: values.selectedGradePreset,
    gradePresets: values.gradePresets,
    loopOptions: {
      maximumRepeatedTrailPct: Number(values.maximumRepeatedTrailPct),
      sharedApproachEnabled: values.maximumSharedStemEnabled,
      maximumSharedApproachMiles: Number(values.maximumSharedStemMiles),
      allowMultiCycle: values.allowMultiCycle,
    },
  }), [values.allowMultiCycle, values.gradeConstraintEnabled, values.gradePresets, values.includeUncertainAccess, values.limit, values.maximumRepeatedTrailPct, values.maximumSharedStemEnabled, values.maximumSharedStemMiles, values.selectedGradePreset]);

  const applySettings = useCallback((settings: AppSettingsV1) => {
    setValues((current) => ({
      ...current,
      includeUncertainAccess: settings.includeUncertainAccess,
      limit: String(settings.quickSearchRouteCount),
      gradeConstraintEnabled: settings.gradeConstraintEnabled,
      selectedGradePreset: settings.selectedGradePreset,
      gradePresets: settings.gradePresets,
      maximumRepeatedTrailPct: String(settings.loopOptions.maximumRepeatedTrailPct),
      maximumSharedStemEnabled: settings.loopOptions.sharedApproachEnabled,
      maximumSharedStemMiles: String(settings.loopOptions.maximumSharedApproachMiles),
      allowMultiCycle: settings.loopOptions.allowMultiCycle,
    }));
  }, []);

  const putSettings = useCallback(async (settings: AppSettingsV1) => {
    try {
      const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
      if (!response.ok) throw new Error("Settings could not be saved.");
      setSettingsError("");
      return true;
    } catch {
      setSettingsError("Settings could not be saved.");
      return false;
    }
  }, []);

  const saveSettings = useCallback(async (settings: AppSettingsV1) => {
    if (!await putSettings(settings)) return false;
    applySettings(settings);
    invalidateResults();
    return true;
  }, [applySettings, invalidateResults, putSettings]);

  const changeGradePreference = useCallback((patch: { gradeConstraintEnabled?: boolean; selectedGradePreset?: GradePresetId }) => {
    const next = { ...appSettings, ...patch };
    applySettings(next);
    invalidateResults();
    void putSettings(next);
  }, [appSettings, applySettings, invalidateResults, putSettings]);

  const changeLoopPreference = useCallback((patch: Partial<AppSettingsV1["loopOptions"]>) => {
    const next = { ...appSettings, loopOptions: { ...appSettings.loopOptions, ...patch } };
    applySettings(next);
    invalidateResults();
    void putSettings(next);
  }, [appSettings, applySettings, invalidateResults, putSettings]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const raw: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error("Settings could not be loaded.");
        const candidate = raw && typeof raw === "object" && "settings" in raw ? raw.settings : raw;
        const parsed = appSettingsV1Schema.safeParse(candidate);
        if (!parsed.success) throw new Error("Settings could not be loaded.");
        applySettings(parsed.data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [applySettings]);

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
    const criteriaValidation = buildGenerateRoutesRequest(
      values,
      drawnBounds ? { mode: "drawn-area", bbox: drawnBounds } : { mode: "drawn-area", bbox: pack.coverageBbox },
      undefined,
      pack.id,
    );
    if (!criteriaValidation.success) errors.push(...criteriaValidation.errors);
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
    setSelectedSegmentId(undefined);
    setHoveredSegmentId(undefined);
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
      setSelectedSegmentId(undefined);
      setHoveredSegmentId(undefined);
      setGenerationMessage(parsed.exact.length ? `${parsed.exact.length} exact ${parsed.exact.length === 1 ? "route" : "routes"} ready.` : `No exact matches. ${parsed.nearMisses.length} close ${parsed.nearMisses.length === 1 ? "match" : "matches"} available.`);
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
    if (batchLaunchInFlightRef.current) return;
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
        ...(request.gradeExperience ? { gradeExperience: request.gradeExperience } : {}),
        includeUncertainAccess: request.includeUncertainAccess,
      },
      routesPerAccessPoint: 10,
    };
    batchLaunchInFlightRef.current = true;
    setBatchLaunching(true);
    setValidationErrors([]);
    setGenerationMessage("Launching batch search…");
    try {
      const response = await fetch("/api/route-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(raw, "Batch search could not be launched."));
      const job = routeJobSchema.parse(raw && typeof raw === "object" && "job" in raw ? raw.job : raw);
      jobsRefreshGenerationRef.current += 1;
      jobsRefreshControllerRef.current?.abort();
      acceptJobs([job, ...jobsRef.current.filter(({ id }) => id !== job.id)], Date.now(), false);
      setGenerationMessage("Batch search queued. Track it in Jobs.");
      setJobsOpen(true);
      void refreshJobs(true);
    } catch (error) { setGenerationMessage(error instanceof Error ? error.message : "Batch search could not be launched."); }
    finally {
      batchLaunchInFlightRef.current = false;
      setBatchLaunching(false);
    }
  };

  const applyBatchResults = useCallback((page: RouteJobResultsPage) => {
    setBatchPage(page);
    const response = batchPageAsResponse(page);
    setGenerationResponse(response);
    setGenerationState("done");
    setGenerationMessage(`${page.results.length} saved routes loaded${page.nextCursor ? "; more are available" : ""}.`);
    setSelectedRouteId((response.exact[0] ?? response.nearMisses[0])?.id);
    setSelectedSegmentId(undefined);
    setHoveredSegmentId(undefined);
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

  const openBatchResults = useCallback((page: RouteJobResultsPage) => {
    if (page.job.pack.id !== pack.id) {
      setJobsOpen(false);
      if (availablePackIds.has(page.job.pack.id)) switchPack(page.job.pack.id, page.job.id);
      else {
        setGenerationState("error");
        setGenerationMessage("The region pack for this saved job is not installed.");
      }
      return;
    }
    applyBatchResults(page);
  }, [applyBatchResults, availablePackIds, pack.id, switchPack]);

  useEffect(() => {
    if (!restoreJobId || restoredJobRef.current === restoreJobId) return;
    restoredJobRef.current = restoreJobId;
    const controller = new AbortController();
    void fetch(`/api/route-jobs/${encodeURIComponent(restoreJobId)}/results?limit=50`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("Job results could not be loaded.");
      const page = routeJobResultsPageSchema.parse(raw);
      if (page.job.pack.id !== pack.id) {
        if (availablePackIds.has(page.job.pack.id)) switchPack(page.job.pack.id, page.job.id);
        else {
          setGenerationState("error");
          setGenerationMessage("The region pack for this saved job is not installed.");
          router.replace(`/?${new URLSearchParams({ pack: pack.id })}`);
        }
        return;
      }
      applyBatchResults(page);
      router.replace(`/?${new URLSearchParams({ pack: pack.id })}`);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setGenerationState("error");
        setGenerationMessage(error instanceof Error ? error.message : "Job results could not be loaded.");
      }
    });
    return () => controller.abort();
  }, [applyBatchResults, availablePackIds, pack.id, restoreJobId, router, switchPack]);

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

  const activeJobCount = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;

  useEffect(() => {
    const needsInitialRefresh = !jobsLoadedRef.current;
    if (!needsInitialRefresh && activeJobCount === 0) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await refreshJobs();
      const hasActiveJob = jobsRef.current.some((job) => ACTIVE_JOB_STATUSES.has(job.status));
      if (!stopped && hasActiveJob) timer = window.setTimeout(() => void poll(), jobsOpen ? JOB_POLL_OPEN_MS : JOB_POLL_CLOSED_MS);
    };
    if (needsInitialRefresh) void poll();
    else timer = window.setTimeout(() => void poll(), jobsOpen ? JOB_POLL_OPEN_MS : JOB_POLL_CLOSED_MS);
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [activeJobCount, jobsOpen, refreshJobs]);

  useEffect(() => {
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void refreshJobs(true); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshJobs]);

  useEffect(() => () => {
    generationControllerRef.current?.abort();
    reachabilityControllerRef.current?.abort();
    jobsRefreshGenerationRef.current += 1;
    jobsRefreshControllerRef.current?.abort();
  }, []);

  // Close matches open themselves only when there is nothing exact to read.
  useEffect(() => { setNearMissesOpen((generationResponse?.exact.length ?? 0) === 0); }, [generationResponse]);

  const generatedRoutes = useMemo(() => generationResponse ? [...generationResponse.exact, ...generationResponse.nearMisses] : [], [generationResponse]);
  // Collapsing the close-match list also takes those traces off the map, so the
  // map never shows more than the list claims to. Exact matches come first,
  // so trimming the tail keeps every remaining result number correct.
  const mappedRoutes = useMemo(() => {
    if (!generationResponse) return [];
    return nearMissesOpen ? generatedRoutes : generationResponse.exact;
  }, [generatedRoutes, generationResponse, nearMissesOpen]);

  const toggleNearMisses = useCallback((open: boolean) => {
    setNearMissesOpen(open);
    if (open) return;
    setSelectedRouteId((current) => {
      const exact = generationResponse?.exact ?? [];
      return current && exact.some(({ id }) => id === current) ? current : exact[0]?.id;
    });
    setSelectedSegmentId(undefined);
    setHoveredSegmentId(undefined);
  }, [generationResponse]);
  const hasResultsPanel = generationState !== "idle";
  const selectedRegion = driveDraft.searchRegions.find(({ id }) => id === driveDraft.searchRegionId);

  return (
    <main className="app-frame">
      <header className="topbar">
        <h1>Alpine Loop</h1>
        <nav className="region-strip" aria-label="Region packs">
          <div className="region-list">
            {orderedRegions.map((region) => {
              const available = region.state === "available";
              const selected = available && region.packId === pack.id;
              const status = region.state === "planned"
                ? "Planned; pack not yet available."
                : region.state === "unavailable"
                  ? "Pack unavailable on this device."
                  : selected
                    ? "Available; currently selected."
                    : "Available.";
              return (
                <button
                  type="button"
                  className={["region-pill", selected ? "region-pill-selected" : ""].filter(Boolean).join(" ")}
                  key={region.id}
                  disabled={!available}
                  aria-pressed={available ? selected : undefined}
                  aria-label={`${region.label}. ${status}`}
                  title={available ? `${region.pack.name} — Data ${region.pack.dataVersion}` : status}
                  onClick={() => { if (available && !selected) switchPack(region.packId); }}
                >
                  {available ? <span className="status-dot" aria-hidden="true" /> : null}
                  <span>{region.label}</span>
                  <span className="visually-hidden"> {status}</span>
                </button>
              );
            })}
          </div>
        </nav>
        <div className="topbar-actions">
          <button type="button" className="chip-button" aria-haspopup="dialog" aria-expanded={jobsOpen} aria-label={activeJobCount ? `Jobs (${activeJobCount})` : "Jobs"} onClick={() => { setJobsOpen(true); void refreshJobs(true); }}>
            Jobs{activeJobCount ? <span className="chip-count" aria-hidden="true">{activeJobCount}</span> : null}
          </button>
          <button type="button" className="chip-button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">{jobsAnnouncement}</p>
        {settingsError ? <p className="settings-error-banner" role="alert">{settingsError}</p> : null}
      </header>

      {settingsOpen ? <SettingsModal open settings={appSettings} onSave={saveSettings} onClose={closeSettings} /> : null}
      <JobsModal open={jobsOpen} jobs={jobs} loadState={jobsLoadState} loadError={jobsLoadError} refreshedAt={jobsRefreshedAt} onRefresh={refreshJobs} onOpenResults={openBatchResults} onClose={closeJobs} />

      <div className={["workspace", hasResultsPanel ? "with-results" : "", desktopBuilderVisible ? "" : "without-builder", hasResultsPanel && !desktopResultsVisible ? "without-results" : ""].filter(Boolean).join(" ")}>
        <nav className="mobile-panel-nav" aria-label="Workspace panels">
          <button type="button" aria-pressed={mobilePanel === "builder"} onClick={() => setMobilePanel("builder")}>Plan</button>
          <button type="button" aria-pressed={mobilePanel === "results"} disabled={!hasResultsPanel} onClick={() => setMobilePanel("results")}>Results{generationResponse ? ` (${generatedRoutes.length})` : ""}</button>
        </nav>

        <button type="button" className="panel-tab panel-tab-left" aria-expanded={desktopBuilderVisible} aria-label={desktopBuilderVisible ? "Collapse plan panel" : "Expand plan panel"} onClick={() => setDesktopBuilderVisible((value) => !value)}>
          <span aria-hidden="true">{desktopBuilderVisible ? "‹" : "›"}</span>
        </button>

        <aside className={["builder-panel", mobilePanel === "builder" ? "" : "mobile-panel-hidden", desktopBuilderVisible ? "" : "desktop-panel-hidden"].filter(Boolean).join(" ")} aria-labelledby="builder-title">
          <div className="builder-scroll">
            <div className="panel-bar"><h2 id="builder-title">Plan</h2></div>

            <section className="panel-section" aria-labelledby="search-area-title">
              <div className="section-head"><h3 id="search-area-title">Search area</h3></div>

              <div className="field-row">
                <label htmlFor="drive-origin">Origin</label>
                <div className="input-with-action">
                  <input id="drive-origin" className="control" type="search" aria-label="Driving origin" value={driveDraft.originText} autoComplete="off" placeholder="Address, place, or lat, lon" onChange={(event) => { const originText = event.currentTarget.value; originRequestSequenceRef.current += 1; reachabilityControllerRef.current?.abort(); const coordinates = parseCoordinateOrigin(originText); setDriveDraft((current) => coordinates?.success
                    ? { ...current, originText, origin: coordinates.data, originSuggestions: [], state: "idle", error: undefined }
                    : { ...current, originText, origin: current.origin?.label === originText ? current.origin : undefined, originSuggestions: [], state: "suggesting", error: undefined }); invalidateResults(); }} />
                </div>
              </div>
              {driveDraft.originSuggestions.length ? <ul className="suggestion-list" role="listbox" aria-label="Origin suggestions">{driveDraft.originSuggestions.map((suggestion) => <li key={suggestion.id}><button type="button" role="option" aria-selected="false" onClick={() => void selectOriginSuggestion(suggestion)}>{suggestion.label}</button></li>)}</ul> : null}
              <div className="field-extra">
                <button className="btn-link" type="button" onClick={useCurrentLocation}>Use my current location</button>
                {driveDraft.origin ? <span className="resolved-value"><code>{driveDraft.origin.lat.toFixed(4)}, {driveDraft.origin.lon.toFixed(4)}</code></span> : null}
              </div>

              <div className="field-row">
                <label htmlFor="drive-duration">Drive time</label>
                <select id="drive-duration" className="control" aria-label="Typical drive time" value={driveDraft.durationMinutes} onChange={(event) => { const durationMinutes = Number(event.currentTarget.value); reachabilityControllerRef.current?.abort(); setDriveDraft((current) => ({ ...current, durationMinutes })); invalidateResults(); }}>{DRIVE_TIME_DURATIONS_MINUTES.map((minutes) => <option value={minutes} key={minutes}>{minutes} minutes</option>)}</select>
              </div>

              <div className="field-row">
                <label htmlFor="search-region">Region</label>
                <select id="search-region" className="control" aria-label="Broad region" value={driveDraft.searchRegionId} disabled={driveDraft.regionsState === "loading"} onChange={(event) => { const searchRegionId = event.currentTarget.value; const region = driveDraft.searchRegions.find(({ id }) => id === searchRegionId); reachabilityControllerRef.current?.abort(); setDriveDraft((current) => ({ ...current, searchRegionId })); if (!drawnBounds) setFilterGeometry(region ? boundsGeometry(region.bbox) : undefined); invalidateResults(); }}><option value="">Choose a region</option>{driveDraft.searchRegions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select>
              </div>
              {driveDraft.regionsState === "loading" ? <p className="loading-state" role="status">Loading regions…</p> : null}
              {driveDraft.error ? <p className="note-error" role="alert">{driveDraft.error}</p> : null}

              <section className="boundary-block" aria-labelledby="boundary-title">
                <div className="boundary-row">
                  <h3 className="field-label" id="boundary-title">Drawn boundary</h3>
                  {drawnBounds
                    ? <output>{drawnBounds.map((value) => value.toFixed(4)).join(", ")}</output>
                    : <output className="empty">None — Quick uses drive time</output>}
                  {drawnBounds ? <button type="button" className="btn-link" onClick={() => { setDrawnBounds(null); setFilterGeometry(selectedRegion ? boundsGeometry(selectedRegion.bbox) : undefined); invalidateResults(); }}>Clear</button> : null}
                </div>
                <p className="hint">Draw on the map to override drive time for Quick search.</p>
              </section>
            </section>

            <section className="panel-section constraints" aria-labelledby="constraints-title">
              <div className="section-head"><h3 id="constraints-title">Route</h3></div>
              <div className="range-table">
                <div className="range-table-header" aria-hidden="true"><span>Constraint</span><span>Min</span><span>Max</span><span>Unit</span></div>
                <RangeInput id="distance" label="Distance" unit="mi" title="Total route distance, up to 30 miles" optional={false} value={values.distanceMiles} onChange={(next) => { patchRange(setValues, "distanceMiles", next); invalidateResults(); }} />
                <RangeInput id="gain" label="Elev. gain" unit="ft" title="Cumulative elevation gain" value={values.elevationGainFeet} onChange={(next) => { patchRange(setValues, "elevationGainFeet", next); invalidateResults(); }} />
                <RangeInput id="altitude" label="Max elev." unit="ft" title="Highest point reached" value={values.maximumElevationFeet} onChange={(next) => { patchRange(setValues, "maximumElevationFeet", next); invalidateResults(); }} />
                <GradePresetInput
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
                    <label className="range-value-cell"><span>Maximum repeated trail</span><input id="maximum-repeated-trail" aria-label="Maximum repeated trail" type="number" min="0" max="100" step="1" value={values.maximumRepeatedTrailPct} onChange={(event) => { const maximumRepeatedTrailPct = event.currentTarget.value; setValues((current) => ({ ...current, maximumRepeatedTrailPct })); invalidateResults(); }} onBlur={(event) => { const maximumRepeatedTrailPct = Number(event.currentTarget.value); if (Number.isInteger(maximumRepeatedTrailPct) && maximumRepeatedTrailPct >= 0 && maximumRepeatedTrailPct <= 100) changeLoopPreference({ maximumRepeatedTrailPct }); }} /></label>
                    <span className="range-unit-cell">%</span>
                  </div>
                  <div className="range-row">
                    <label className="range-toggle" title="Same approach trail used while leaving and returning near the trailhead">
                      <input type="checkbox" checked={values.maximumSharedStemEnabled} onChange={(event) => changeLoopPreference({ sharedApproachEnabled: event.currentTarget.checked })} />
                      <span>Shared approach</span>
                    </label>
                    <span aria-hidden="true" />
                    <label className="range-value-cell"><span>Maximum shared approach</span><input id="maximum-shared-stem" aria-label="Maximum shared approach" type="number" min="0" max="30" step="0.1" disabled={!values.maximumSharedStemEnabled} value={values.maximumSharedStemMiles} onChange={(event) => { const maximumSharedStemMiles = event.currentTarget.value; setValues((current) => ({ ...current, maximumSharedStemMiles })); invalidateResults(); }} onBlur={(event) => { const maximumSharedApproachMiles = Number(event.currentTarget.value); if (Number.isFinite(maximumSharedApproachMiles) && maximumSharedApproachMiles >= 0 && maximumSharedApproachMiles <= 30) changeLoopPreference({ maximumSharedApproachMiles }); }} /></label>
                    <span className="range-unit-cell">mi</span>
                  </div>
                </div>
                <label className="switch-row">
                  <span>Allow figure-eights and chained loops</span>
                  <input type="checkbox" role="switch" checked={values.allowMultiCycle} onChange={(event) => changeLoopPreference({ allowMultiCycle: event.currentTarget.checked })} />
                </label>
              </div>
            </details>
          </div>

          <footer className="builder-action-footer">
            {validationErrors.length ? <div className="validation-errors" role="alert"><strong>Check your route settings:</strong><ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
            <div className="builder-action-buttons">
              <button className="btn btn-primary" type="button" disabled={generationState === "loading"} onClick={() => void runQuick()}>{generationState === "loading" ? "Searching…" : "Quick search"}</button>
              <button className="btn btn-primary" type="button" disabled={batchLaunching} onClick={() => void launchBatch()}>{batchLaunching ? "Starting…" : "Full search"}</button>
            </div>
            <div className="action-legend" aria-hidden="true"><span>Fast · partial</span><span>Thorough · background</span></div>
            {generationMessage ? <p className="generation-status" role="status" aria-live="polite">{generationMessage}</p> : null}
          </footer>
        </aside>

        <HikeMap packId={pack.id} drawBounds={drawnBounds} drawEnabled filterGeometry={filterGeometry} packCoverageBbox={pack.coverageBbox} packCoverage={pack.coverage} suggestedBounds={pack.suggestedBounds} display={pack.display} trailNetwork={trailNetwork} accessPoints={displayedAccessPoints} routes={mappedRoutes} selectedRouteId={selectedRouteId} selectedSegmentId={selectedSegmentId} hoveredSegmentId={hoveredSegmentId} onBoundsChange={(bounds) => { setDrawnBounds(bounds); setFilterGeometry(bounds ? boundsGeometry(bounds) : selectedRegion ? boundsGeometry(selectedRegion.bbox) : undefined); invalidateResults(); }} onAccessPointSelect={() => undefined} onRouteSelect={selectRoute} onRouteHover={setHoveredRouteId} onSegmentSelect={setSelectedSegmentId} onSegmentHover={setHoveredSegmentId} />

        {hasResultsPanel ? <ResultsPanel status={generationState as ResultsStatus} response={generationResponse} message={generationMessage} selectedRouteId={selectedRouteId} hoveredRouteId={hoveredRouteId} selectedSegmentId={selectedSegmentId} hoveredSegmentId={hoveredSegmentId} nearMissesOpen={nearMissesOpen} onToggleNearMisses={toggleNearMisses} onSelectRoute={selectRoute} onSelectSegment={setSelectedSegmentId} onHoverSegment={setHoveredSegmentId} mobileVisible={mobilePanel === "results"} desktopVisible={desktopResultsVisible} pagination={batchPage ? { hasNext: Boolean(batchPage.nextCursor), loading: batchPageLoading, onNext: () => void loadNextBatchPage() } : undefined} /> : null}

        {hasResultsPanel ? (
          <button type="button" className="panel-tab panel-tab-right" aria-expanded={desktopResultsVisible} aria-label={desktopResultsVisible ? "Collapse results panel" : "Expand results panel"} onClick={() => setDesktopResultsVisible((value) => !value)}>
            <span aria-hidden="true">{desktopResultsVisible ? "›" : "‹"}</span>
          </button>
        ) : null}
      </div>
    </main>
  );
}
