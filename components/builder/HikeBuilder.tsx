"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  generateClosedRoutesResponseV3Schema,
  namedAreaSchema,
  namedAreaSummarySchema,
  originSchema,
  reachabilityResponseSchema,
  type AccessFilterV2,
  type GenerateClosedRoutesRequestV3,
  type GenerateClosedRoutesResponseV3,
  type NamedAreaSummary,
} from "@/lib/contracts";
import { FIXTURE_BUILDER_PACK, type BuilderPackConfig } from "@/lib/packs/fixture-pack";
import { HikeMap } from "../map/HikeMap";
import { ResultsPanel, type ResultsStatus } from "../results/ResultsPanel";
import { BoundaryEditor } from "./BoundaryEditor";
import { RangeInput } from "./RangeInput";
import { SettingsModal } from "./SettingsModal";
import {
  DEFAULT_BUILDER_VALUES,
  EMPTY_NAMED_REGION_DRAFT,
  type AccessPointOption,
  type Bounds,
  type BuilderValues,
  type DriveTimeDraft,
  type FilterMode,
  type NamedRegionDraft,
  type RangeField,
} from "./types";
import { buildGenerateRoutesRequest } from "./validation";

const FILTER_MODES: Array<{ id: FilterMode; label: string; help: string }> = [
  { id: "drawn-area", label: "Draw area", help: "Draw or enter a rectangle." },
  { id: "named-region", label: "Named region", help: "Choose an installed region." },
  { id: "drive-time", label: "Drive time", help: "Typical driving time from an origin." },
];

type AreaGeometry = Polygon | MultiPolygon;

function boundsGeometry(bounds: Bounds): Polygon {
  const [west, south, east, north] = bounds;
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

function patchRange(
  setValues: React.Dispatch<React.SetStateAction<BuilderValues>>,
  key: keyof Pick<BuilderValues, "distanceMiles" | "elevationGainFeet" | "maximumElevationFeet" | "steepestSustainedGradePct">,
  next: RangeField,
) {
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

function RegionChooser({
  id,
  draft,
  onQuery,
  onSelect,
  onClear,
  optional = false,
}: {
  id: string;
  draft: NamedRegionDraft;
  onQuery: (query: string) => void;
  onSelect: (area: NamedAreaSummary) => void;
  onClear: () => void;
  optional?: boolean;
}) {
  return (
    <div className="autocomplete-field">
      <label htmlFor={id}>{optional ? "Named-region refinement" : "Installed named region"}</label>
      <div className="input-with-action">
        <input
          id={id}
          type="search"
          autoComplete="off"
          value={draft.query}
          aria-autocomplete="list"
          aria-controls={`${id}-suggestions`}
          placeholder={optional ? "Optional park, city, or county" : "Park, preserve, city, or county"}
          onChange={(event) => onQuery(event.currentTarget.value)}
        />
        {draft.selected ? <button type="button" onClick={onClear}>Clear</button> : null}
      </div>
      {draft.state === "searching" || draft.state === "loading" ? <p className="inline-status" role="status">Searching installed regions…</p> : null}
      {draft.error ? <p className="error-state" role="alert">{draft.error}</p> : null}
      {!draft.selected && draft.suggestions.length > 0 ? (
        <ul id={`${id}-suggestions`} className="suggestion-list" role="listbox" aria-label="Named region suggestions">
          {draft.suggestions.map((area) => (
            <li key={area.id}>
              <button type="button" role="option" aria-selected="false" onClick={() => onSelect(area)}>
                <strong>{area.name}</strong><span>{area.kind.replaceAll("-", " ")}{area.context ? ` · ${area.context}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {draft.selected ? <p className="selection-chip"><span aria-hidden="true">✓</span><strong>{draft.selected.name}</strong><small>{draft.selected.kind.replaceAll("-", " ")}</small></p> : null}
      {!draft.selected && draft.query.length >= 2 ? (
        <p className="field-help">Select a suggestion; typed names are never converted into rectangles.</p>
      ) : null}
    </div>
  );
}

export function HikeBuilder({ pack = FIXTURE_BUILDER_PACK }: { pack?: BuilderPackConfig }) {
  const [mode, setMode] = useState<FilterMode>("drawn-area");
  const [drawnDraft, setDrawnDraft] = useState<{ bounds: Bounds | null }>({ bounds: null });
  const [namedDraft, setNamedDraft] = useState<NamedRegionDraft>(EMPTY_NAMED_REGION_DRAFT);
  const [driveDraft, setDriveDraft] = useState<DriveTimeDraft>({
    originText: "",
    originSuggestions: [],
    durationMinutes: 30,
    state: "idle",
    refinement: EMPTY_NAMED_REGION_DRAFT,
  });
  const [values, setValues] = useState<BuilderValues>(DEFAULT_BUILDER_VALUES);
  const [filterGeometry, setFilterGeometry] = useState<AreaGeometry>();
  const [refinementGeometry, setRefinementGeometry] = useState<AreaGeometry>();
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
  const [mobilePanel, setMobilePanel] = useState<"builder" | "results">("builder");
  const [desktopBuilderVisible, setDesktopBuilderVisible] = useState(true);
  const [desktopResultsVisible, setDesktopResultsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const generationControllerRef = useRef<AbortController | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  const reachabilityControllerRef = useRef<AbortController | null>(null);
  const eligibleAccessPointsRef = useRef(accessPoints);

  useEffect(() => {
    eligibleAccessPointsRef.current = accessPoints;
  }, [accessPoints]);

  const cancelReachability = useCallback(() => {
    reachabilityControllerRef.current?.abort();
    reachabilityControllerRef.current = null;
    if (driveDraft.state === "calculating" && driveDraft.requestId) {
      void fetch(`/api/reachability/${driveDraft.requestId}`, { method: "DELETE" }).catch(() => undefined);
    }
  }, [driveDraft.requestId, driveDraft.state]);

  const invalidateResults = useCallback(() => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    setGenerationState("idle");
    setGenerationMessage("");
    setGenerationResponse(null);
    setSelectedRouteId(undefined);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const updateSettings = useCallback((patch: Partial<Pick<BuilderValues,
    "searchEffort" | "includeUncertainAccess" | "accessPointRemoteness" | "limit">>) => {
    setValues((current) => ({ ...current, ...patch }));
    invalidateResults();
  }, [invalidateResults]);

  const changeMode = (next: FilterMode) => {
    if (next === mode) return;
    previewControllerRef.current?.abort();
    cancelReachability();
    setDriveDraft((current) => current.state === "calculating" ? { ...current, state: "idle", requestId: undefined, geometry: undefined } : current);
    setMode(next);
    setAccessPoints([]);
    setSelectedAccessPointId(undefined);
    setAccessState("idle");
    setFilterGeometry(undefined);
    setRefinementGeometry(undefined);
    invalidateResults();
  };

  const onBoundsChange = useCallback((bounds: Bounds | null) => {
    setDrawnDraft({ bounds });
    setFilterGeometry(bounds ? boundsGeometry(bounds) : undefined);
    setAccessPoints([]);
    setSelectedAccessPointId(undefined);
    invalidateResults();
  }, [invalidateResults]);
  const onAccessPointSelect = useCallback((id: string) => {
    if (!eligibleAccessPointsRef.current.some((point) => point.id === id)) return;
    setSelectedAccessPointId(id);
    invalidateResults();
  }, [invalidateResults]);

  useEffect(() => {
    if (pack.id === FIXTURE_BUILDER_PACK.id) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      bbox: pack.coverageBbox.join(","),
      includeUncertainAccess: "true",
      includeTrails: "false",
    });
    void fetch(`/api/packs/${pack.id}/access-points?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !payload || typeof payload !== "object"
          || !("accessPoints" in payload) || !Array.isArray(payload.accessPoints)) return;
        setVisibleAccessPoints(payload.accessPoints as AccessPointOption[]);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [pack.coverageBbox, pack.id]);

  const activeAccessFilter = useMemo<AccessFilterV2 | null>(() => {
    if (mode === "drawn-area") return drawnDraft.bounds ? { mode, bbox: drawnDraft.bounds } : null;
    if (mode === "named-region") return namedDraft.selected ? { mode, regionId: namedDraft.selected.id } : null;
    if (!driveDraft.requestId || !driveDraft.geometry || driveDraft.state !== "ready") return null;
    return {
      mode,
      reachabilityId: driveDraft.requestId,
      ...(driveDraft.refinement.selected ? { regionId: driveDraft.refinement.selected.id } : {}),
    };
  }, [drawnDraft.bounds, driveDraft.geometry, driveDraft.refinement.selected, driveDraft.requestId, driveDraft.state, mode, namedDraft.selected]);

  const displayedAccessPoints = useMemo(() => visibleAccessPoints.filter((point) =>
    values.accessPointRemoteness.includes(point.remoteness ?? "unknown")
    && (values.includeUncertainAccess || point.accessState !== "unknown")), [
    values.accessPointRemoteness,
    values.includeUncertainAccess,
    visibleAccessPoints,
  ]);

  const setRegionQuery = useCallback((target: "named" | "refinement", query: string) => {
    const patch = (current: NamedRegionDraft): NamedRegionDraft => ({
      ...current,
      query,
      suggestions: [],
      selected: current.selected?.name === query ? current.selected : undefined,
      state: query.trim().length >= 2 ? "searching" : "idle",
      error: undefined,
    });
    if (target === "named") setNamedDraft(patch);
    else setDriveDraft((current) => ({ ...current, refinement: patch(current.refinement) }));
    invalidateResults();
  }, [invalidateResults]);

  useEffect(() => {
    const draft = mode === "named-region" ? namedDraft : mode === "drive-time" ? driveDraft.refinement : null;
    if (!draft || draft.state !== "searching" || draft.selected || draft.query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ q: draft.query.trim() });
      void fetch(`/api/packs/${pack.id}/named-areas?${query}`, { signal: controller.signal })
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(parseError(payload, "Installed regions could not be searched."));
          const raw = Array.isArray(payload)
            ? payload
            : payload && typeof payload === "object" && "regions" in payload
              ? payload.regions
              : payload && typeof payload === "object" && "areas" in payload
                ? payload.areas
                : [];
          return namedAreaSummarySchema.array().parse(raw);
        })
        .then((suggestions) => {
          const patch = (current: NamedRegionDraft): NamedRegionDraft => current.query === draft.query ? { ...current, suggestions, state: "idle" } : current;
          if (mode === "named-region") setNamedDraft(patch);
          else setDriveDraft((current) => ({ ...current, refinement: patch(current.refinement) }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const patch = (current: NamedRegionDraft): NamedRegionDraft => ({ ...current, state: "error", error: error instanceof Error ? error.message : "Installed regions could not be searched." });
          if (mode === "named-region") setNamedDraft(patch);
          else setDriveDraft((current) => ({ ...current, refinement: patch(current.refinement) }));
        });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [driveDraft.refinement, mode, namedDraft, pack.id]);

  const selectRegion = async (target: "named" | "refinement", summary: NamedAreaSummary) => {
    const loading = (current: NamedRegionDraft): NamedRegionDraft => ({ ...current, query: summary.name, suggestions: [], state: "loading", error: undefined });
    if (target === "named") setNamedDraft(loading);
    else setDriveDraft((current) => ({ ...current, refinement: loading(current.refinement) }));
    try {
      const response = await fetch(`/api/packs/${pack.id}/named-areas/${encodeURIComponent(summary.id)}`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "That installed region could not be loaded."));
      const selected = namedAreaSchema.parse(
        payload && typeof payload === "object" && "region" in payload
          ? payload.region
          : payload && typeof payload === "object" && "area" in payload
            ? payload.area
            : payload,
      );
      const ready = (current: NamedRegionDraft): NamedRegionDraft => ({ ...current, query: selected.name, selected, state: "ready", suggestions: [], error: undefined });
      if (target === "named") {
        setNamedDraft(ready);
        setFilterGeometry(selected.geometry);
      } else {
        setDriveDraft((current) => ({ ...current, refinement: ready(current.refinement) }));
        setRefinementGeometry(selected.geometry);
      }
    } catch (error: unknown) {
      const failed = (current: NamedRegionDraft): NamedRegionDraft => ({ ...current, state: "error", error: error instanceof Error ? error.message : "That installed region could not be loaded." });
      if (target === "named") setNamedDraft(failed);
      else setDriveDraft((current) => ({ ...current, refinement: failed(current.refinement) }));
    }
  };

  useEffect(() => {
    if (mode !== "drive-time" || driveDraft.state !== "suggesting" || driveDraft.origin || driveDraft.originText.trim().length < 2 || parseCoordinateOrigin(driveDraft.originText)?.success) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/geocoding/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packId: pack.id, text: driveDraft.originText.trim() }),
        signal: controller.signal,
      }).then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(parseError(payload, "Origin suggestions are unavailable."));
        const suggestions = payload && typeof payload === "object" && "suggestions" in payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
        setDriveDraft((current) => current.originText === driveDraft.originText ? { ...current, originSuggestions: suggestions, state: "idle" } : current);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "Origin suggestions are unavailable." }));
      });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [driveDraft.origin, driveDraft.originText, driveDraft.state, mode, pack.id]);

  const selectOriginSuggestion = async (suggestion: { label: string; magicKey: string }) => {
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined, originSuggestions: [] }));
    try {
      const response = await fetch("/api/geocoding/resolve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ packId: pack.id, text: suggestion.label, magicKey: suggestion.magicKey }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "That origin could not be resolved."));
      const origin = originSchema.parse(payload && typeof payload === "object" && "origin" in payload ? payload.origin : payload);
      setDriveDraft((current) => ({ ...current, originText: origin.label, origin, state: "idle", error: undefined }));
    } catch (error: unknown) {
      setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "That origin could not be resolved." }));
    }
  };

  const useTypedCoordinates = () => {
    const parsed = parseCoordinateOrigin(driveDraft.originText);
    if (!parsed?.success) {
      setDriveDraft((current) => ({ ...current, state: "error", error: "Enter coordinates as latitude, longitude." }));
      return;
    }
    setDriveDraft((current) => ({ ...current, origin: parsed.data, originText: parsed.data.label, originSuggestions: [], state: "idle", error: undefined }));
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setDriveDraft((current) => ({ ...current, state: "error", error: "Location is not available in this browser." }));
      return;
    }
    setDriveDraft((current) => ({ ...current, state: "resolving", error: undefined }));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const origin = { lon: coords.longitude, lat: coords.latitude, label: "Current location" };
        setDriveDraft((current) => ({ ...current, origin, originText: origin.label, state: "idle" }));
      },
      () => setDriveDraft((current) => ({ ...current, state: "error", error: "Location permission was denied. Type an origin or coordinates instead." })),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    );
  };

  const calculateDriveArea = async () => {
    if (!driveDraft.origin) {
      setDriveDraft((current) => ({ ...current, state: "error", error: "Select an origin suggestion or use coordinates first." }));
      return;
    }
    reachabilityControllerRef.current?.abort();
    invalidateResults();
    const controller = new AbortController();
    reachabilityControllerRef.current = controller;
    setDriveDraft((current) => ({ ...current, state: "calculating", requestId: undefined, geometry: undefined, error: undefined }));
    try {
      let response = await fetch("/api/reachability", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ version: 1, packId: pack.id, origin: driveDraft.origin, durationMinutes: driveDraft.durationMinutes }),
      });
      let payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "The drive-time area could not be calculated."));
      let parsed = reachabilityResponseSchema.parse(payload);
      while (parsed.status === "pending") {
        const pollAfterMs = parsed.pollAfterMs;
        const requestId = parsed.requestId;
        setDriveDraft((current) => ({ ...current, requestId }));
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, pollAfterMs);
          controller.signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        });
        response = await fetch(`/api/reachability/${requestId}`, { signal: controller.signal });
        payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(parseError(payload, "The drive-time area could not be calculated."));
        parsed = reachabilityResponseSchema.parse(payload);
      }
      setDriveDraft((current) => ({ ...current, requestId: parsed.requestId, geometry: parsed.geometry, state: "ready", error: undefined }));
      setFilterGeometry(parsed.geometry);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setDriveDraft((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : "The drive-time area could not be calculated." }));
    } finally {
      if (reachabilityControllerRef.current === controller) reachabilityControllerRef.current = null;
    }
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
      body: JSON.stringify({
        accessFilter: activeAccessFilter,
        includeUncertainAccess: values.includeUncertainAccess,
        accessPointRemoteness: values.accessPointRemoteness,
      }),
    }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "Eligible access points could not be loaded."));
      if (!payload || typeof payload !== "object" || !("accessPoints" in payload) || !Array.isArray(payload.accessPoints)) throw new Error("Access-point preview data was invalid.");
      setAccessPoints(payload.accessPoints as AccessPointOption[]);
      if ("filterGeometry" in payload && payload.filterGeometry) setFilterGeometry(payload.filterGeometry as AreaGeometry);
      if ("refinementGeometry" in payload && payload.refinementGeometry) setRefinementGeometry(payload.refinementGeometry as AreaGeometry);
      if ("trailNetwork" in payload && isTrailNetwork(payload.trailNetwork)) setTrailNetwork(payload.trailNetwork);
      setAccessState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setAccessState("error");
      setAccessError(error instanceof Error ? error.message : "Eligible access points could not be loaded.");
    });
    return () => controller.abort();
  }, [activeAccessFilter, pack.id, values.accessPointRemoteness, values.includeUncertainAccess]);

  useEffect(() => () => {
    generationControllerRef.current?.abort();
    previewControllerRef.current?.abort();
    reachabilityControllerRef.current?.abort();
  }, []);

  const generate = async () => {
    const validated = buildGenerateRoutesRequest(values, activeAccessFilter, selectedAccessPointId, pack.id);
    if (!validated.success) { setValidationErrors(validated.errors); return; }
    generationControllerRef.current?.abort();
    const controller = new AbortController();
    generationControllerRef.current = controller;
    setValidationErrors([]);
    setGenerationState("loading");
    setGenerationMessage("Searching eligible trailheads and generating routes…");
    setGenerationResponse(null);
    setSelectedRouteId(undefined);
    try {
      const response = await fetch("/api/routes/generate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(validated.request satisfies GenerateClosedRoutesRequestV3), signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(parseError(payload, "Routes could not be generated. Try a different filter or constraints."));
      const parsed = generateClosedRoutesResponseV3Schema.parse(payload);
      const firstRoute = parsed.exact[0] ?? parsed.nearMisses[0];
      setGenerationResponse(parsed);
      setSelectedRouteId(firstRoute?.id);
      setGenerationMessage(parsed.exact.length === 0
        ? `No exact matches. ${parsed.nearMisses.length} near ${parsed.nearMisses.length === 1 ? "match is" : "matches are"} available.`
        : `${parsed.exact.length} exact ${parsed.exact.length === 1 ? "route" : "routes"} ready.`);
      setGenerationState("done");
      setMobilePanel("results");
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        if (generationControllerRef.current !== controller) return;
        setGenerationMessage("Route generation was cancelled.");
        setGenerationState("cancelled");
      } else {
        setGenerationMessage(error instanceof Error ? error.message : "Routes could not be generated.");
        setGenerationState("error");
      }
      setMobilePanel("results");
    } finally {
      if (generationControllerRef.current === controller) generationControllerRef.current = null;
    }
  };

  const generatedRoutes = useMemo(() => generationResponse ? [...generationResponse.exact, ...generationResponse.nearMisses] : [], [generationResponse]);
  const hasResultsPanel = generationState !== "idle";

  return (
    <main className="app-frame">
      <header className="topbar">
        <div><span className="eyebrow">Trail graph route builder</span><h1>Alpine Search</h1></div>
        <div className="pack-status" aria-label="Installed region pack"><span className="status-dot" aria-hidden="true" /><span><strong>{pack.name}</strong><small>{pack.subtitle}</small></span></div>
        <button
          type="button"
          className="settings-button"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        >Settings</button>
        <nav className="desktop-panel-controls" aria-label="Desktop panels">
          <button type="button" aria-label="Toggle plan panel" aria-pressed={desktopBuilderVisible} onClick={() => setDesktopBuilderVisible((value) => !value)}>Plan</button>
          <button type="button" aria-label="Toggle results panel" aria-pressed={desktopResultsVisible && hasResultsPanel} disabled={!hasResultsPanel} onClick={() => setDesktopResultsVisible((value) => !value)}>Results</button>
        </nav>
      </header>

      <SettingsModal
        open={settingsOpen}
        searchEffort={values.searchEffort}
        includeUncertainAccess={values.includeUncertainAccess}
        accessPointRemoteness={values.accessPointRemoteness}
        limit={values.limit}
        onChange={updateSettings}
        onClose={closeSettings}
      />

      <div className={["workspace", hasResultsPanel ? "with-results" : "", desktopBuilderVisible ? "" : "without-builder", hasResultsPanel && !desktopResultsVisible ? "without-results" : ""].filter(Boolean).join(" ")}>
        <nav className="mobile-panel-nav" aria-label="Workspace panels">
          <button type="button" aria-pressed={mobilePanel === "builder"} onClick={() => setMobilePanel("builder")}>Plan</button>
          <button type="button" aria-pressed={mobilePanel === "results"} disabled={!hasResultsPanel} onClick={() => setMobilePanel("results")}>Results{generationResponse ? ` (${generatedRoutes.length})` : ""}</button>
        </nav>
        <aside className={["builder-panel", mobilePanel === "builder" ? "" : "mobile-panel-hidden", desktopBuilderVisible ? "" : "desktop-panel-hidden"].filter(Boolean).join(" ")} aria-labelledby="builder-title">
          <div className="panel-heading builder-console-heading"><div className="builder-console-title"><h2 id="builder-title">Build your route</h2></div><span className="builder-console-badge">Trailhead filter</span></div>

          <section className="builder-section filter-section" aria-labelledby="filter-title">
            <div className="section-title"><h3 id="filter-title">Trailhead filter</h3><span>Required</span></div>
            <p className="filter-explainer">Highlighted areas filter trailheads, not route geometry.</p>
            <div className="filter-mode-tabs" role="radiogroup" aria-label="Trailhead filter mode">
              {FILTER_MODES.map((filterMode) => <label key={filterMode.id} className={mode === filterMode.id ? "selected" : ""}><input type="radio" name="filter-mode" value={filterMode.id} checked={mode === filterMode.id} onChange={() => changeMode(filterMode.id)} /><strong>{filterMode.label}</strong><small>{filterMode.help}</small></label>)}
            </div>

            {mode === "drawn-area" ? <div className="filter-editor"><p>Draw on the map or enter coordinates with the keyboard.</p><BoundaryEditor key={drawnDraft.bounds?.join(",") ?? "empty"} bounds={drawnDraft.bounds} onChange={onBoundsChange} />{drawnDraft.bounds ? <output className="boundary-summary complete"><span aria-hidden="true">✓</span>{drawnDraft.bounds.map((value) => value.toFixed(4)).join(", ")}</output> : <p className="empty-state">No area drawn yet.</p>}</div> : null}
            {mode === "named-region" ? <RegionChooser id="named-region" draft={namedDraft} onQuery={(query) => setRegionQuery("named", query)} onSelect={(area) => void selectRegion("named", area)} onClear={() => { setNamedDraft(EMPTY_NAMED_REGION_DRAFT); setFilterGeometry(undefined); invalidateResults(); }} /> : null}
            {mode === "drive-time" ? (
              <div className="drive-filter-editor">
                <label htmlFor="drive-origin">Driving origin</label>
                <div className="input-with-action"><input id="drive-origin" type="search" value={driveDraft.originText} autoComplete="off" placeholder="Address, place, or latitude, longitude" onChange={(event) => { const originText = event.currentTarget.value; cancelReachability(); setDriveDraft((current) => ({ ...current, originText, origin: current.origin?.label === originText ? current.origin : undefined, requestId: undefined, geometry: undefined, state: "suggesting", error: undefined })); setFilterGeometry(undefined); invalidateResults(); }} /><button type="button" onClick={useTypedCoordinates}>Use coordinates</button></div>
                {driveDraft.originSuggestions.length > 0 ? <ul className="suggestion-list" role="listbox" aria-label="Origin suggestions">{driveDraft.originSuggestions.map((suggestion) => <li key={suggestion.id}><button type="button" role="option" aria-selected="false" onClick={() => void selectOriginSuggestion(suggestion)}><strong>{suggestion.label}</strong></button></li>)}</ul> : null}
                <button className="location-button" type="button" onClick={useCurrentLocation}>Use my current location</button>
                {driveDraft.origin ? <p className="selection-chip"><span aria-hidden="true">✓</span><strong>{driveDraft.origin.label}</strong><small>{driveDraft.origin.lat.toFixed(5)}, {driveDraft.origin.lon.toFixed(5)}</small></p> : null}
                <label className="select-field" htmlFor="drive-duration">Typical drive time<select id="drive-duration" value={driveDraft.durationMinutes} onChange={(event) => { const durationMinutes = Number(event.currentTarget.value); cancelReachability(); setDriveDraft((current) => ({ ...current, durationMinutes, requestId: undefined, geometry: undefined, state: "idle" })); setFilterGeometry(undefined); invalidateResults(); }}>{DRIVE_TIME_DURATIONS_MINUTES.map((minutes) => <option value={minutes} key={minutes}>{minutes} minutes</option>)}</select></label>
                <button className="calculate-button" type="button" disabled={!driveDraft.origin || driveDraft.state === "calculating"} onClick={() => void calculateDriveArea()}>{driveDraft.state === "calculating" ? "Calculating…" : "Calculate drive-time area"}</button>
                {driveDraft.state === "ready" ? <p className="inline-status success" role="status">Drive-time area ready. Typical/static travel time; live traffic is not used.</p> : null}
                {driveDraft.error ? <p className="error-state" role="alert">{driveDraft.error}</p> : null}
                <RegionChooser id="drive-refinement" optional draft={driveDraft.refinement} onQuery={(query) => setRegionQuery("refinement", query)} onSelect={(area) => void selectRegion("refinement", area)} onClear={() => { setDriveDraft((current) => ({ ...current, refinement: EMPTY_NAMED_REGION_DRAFT })); setRefinementGeometry(undefined); invalidateResults(); }} />
                <p className="provider-note">Typical drive-time polygons by Esri · no origin history is saved.</p>
              </div>
            ) : null}
          </section>

          <section className="builder-section" aria-labelledby="access-title">
            <div className="section-title"><h3 id="access-title">Starting access point</h3><span>Optional</span></div>
            <p>Choose an eligible trailhead, or search automatically.</p>
            {!activeAccessFilter ? <p className="empty-state">Complete the trailhead filter to preview eligible access.</p> : null}
            {accessState === "loading" ? <p className="loading-state" role="status">Finding eligible access points…</p> : null}
            {accessState === "error" ? <p className="error-state" role="alert">{accessError}</p> : null}
            {activeAccessFilter && accessState === "ready" && accessPoints.length === 0 ? <p className="empty-state" role="status">No eligible access points match this filter.</p> : null}
            {accessPoints.length > 0 ? <label className="select-field" htmlFor="access-point">Access point<select id="access-point" value={selectedAccessPointId ?? ""} onChange={(event) => { setSelectedAccessPointId(event.currentTarget.value || undefined); invalidateResults(); }}><option value="">Choose automatically</option>{accessPoints.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label> : null}
          </section>

          <section className="builder-section" aria-labelledby="closed-route-title">
            <div className="section-title"><h3 id="closed-route-title">Closed route</h3><span>Start and finish together</span></div>
            <p className="filter-explainer">Closed routes start and finish at the same trailhead. Some may reuse an access stem; the repetition control limits how much trail is walked twice.</p>
            <div className="count-field">
              <label htmlFor="maximum-repeated-trail">Maximum repeated trail</label>
              <input id="maximum-repeated-trail" type="range" min="0" max="100" step="1" value={values.maximumRepeatedTrailPct} aria-valuetext={`${values.maximumRepeatedTrailPct}%`} onChange={(event) => { const maximumRepeatedTrailPct = event.currentTarget.value; setValues((current) => ({ ...current, maximumRepeatedTrailPct })); invalidateResults(); }} />
              <output htmlFor="maximum-repeated-trail">{values.maximumRepeatedTrailPct}%</output>
              <small>0% allows only routes with no repeated trail.</small>
            </div>
            <label className="switch-row"><span><strong>Limit the shared access stem</strong><small>Optional one-way distance before the loop begins.</small></span><input type="checkbox" role="switch" checked={values.maximumSharedStemEnabled} onChange={(event) => { const maximumSharedStemEnabled = event.currentTarget.checked; setValues((current) => ({ ...current, maximumSharedStemEnabled })); invalidateResults(); }} /></label>
            {values.maximumSharedStemEnabled ? <div className="count-field"><label htmlFor="maximum-shared-stem">Maximum shared stem</label><input id="maximum-shared-stem" type="number" min="0" max="30" step="0.1" value={values.maximumSharedStemMiles} onChange={(event) => { const maximumSharedStemMiles = event.currentTarget.value; setValues((current) => ({ ...current, maximumSharedStemMiles })); invalidateResults(); }} /><small>Miles, one way (0 to 30)</small></div> : null}
            <label className="switch-row"><span><strong>Allow figure-eights and chained loops</strong><small>On by default. Turn off to require exactly one cycle.</small></span><input type="checkbox" role="switch" checked={values.allowMultiCycle} onChange={(event) => { const allowMultiCycle = event.currentTarget.checked; setValues((current) => ({ ...current, allowMultiCycle })); invalidateResults(); }} /></label>
          </section>

          <section className="builder-section constraints" aria-labelledby="constraints-title"><div className="section-title"><h3 id="constraints-title">Physical constraints</h3><span>Min – max</span></div><div className="range-table"><div className="range-table-header" aria-hidden="true"><span>Constraint</span><span>Minimum</span><span>Maximum</span><span>Unit</span></div><RangeInput id="distance" label="Distance" unit="miles (max 30)" optional={false} value={values.distanceMiles} onChange={(next) => { patchRange(setValues, "distanceMiles", next); invalidateResults(); }} /><RangeInput id="gain" label="Elevation gain" unit="feet" value={values.elevationGainFeet} onChange={(next) => patchRange(setValues, "elevationGainFeet", next)} /><RangeInput id="altitude" label="Maximum elevation" unit="feet" value={values.maximumElevationFeet} onChange={(next) => patchRange(setValues, "maximumElevationFeet", next)} /><RangeInput id="grade" label="Steepest sustained grade" unit="% over 100 m" value={values.steepestSustainedGradePct} onChange={(next) => patchRange(setValues, "steepestSustainedGradePct", next)} /></div></section>

          <footer className="builder-action-footer">{validationErrors.length > 0 ? <div className="validation-errors" role="alert"><strong>Check your route settings:</strong><ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}<div className="builder-action-buttons"><button className="generate-button" type="button" disabled={generationState === "loading"} onClick={() => void generate()}>{generationState === "loading" ? "Generating…" : "Generate routes"}</button>{generationState === "loading" ? <button className="cancel-button" type="button" onClick={() => { generationControllerRef.current?.abort(); setGenerationMessage("Route generation was cancelled."); setGenerationState("cancelled"); setMobilePanel("results"); }}>Cancel generation</button> : null}</div>{generationMessage ? <p className={generationState === "error" ? "generation-status error-state" : "generation-status"} role={generationState === "error" ? "alert" : "status"} aria-live="polite">{generationMessage}</p> : null}</footer>
        </aside>

        <HikeMap mode={mode} drawBounds={drawnDraft.bounds} drawEnabled={mode === "drawn-area"} filterGeometry={filterGeometry} refinementGeometry={refinementGeometry} packCoverageBbox={pack.coverageBbox} packCoverage={pack.coverage} suggestedBounds={pack.suggestedBounds} display={pack.display} trailNetwork={trailNetwork} accessPoints={displayedAccessPoints} selectedAccessPointId={selectedAccessPointId} routes={generatedRoutes} selectedRouteId={selectedRouteId} onBoundsChange={onBoundsChange} onAccessPointSelect={onAccessPointSelect} onRouteSelect={setSelectedRouteId} />
        {hasResultsPanel ? <ResultsPanel status={generationState} response={generationResponse} message={generationMessage} selectedRouteId={selectedRouteId} onSelectRoute={setSelectedRouteId} mobileVisible={mobilePanel === "results"} desktopVisible={desktopResultsVisible} /> : null}
      </div>
    </main>
  );
}
