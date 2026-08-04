"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bboxSchema,
  generateRoutesResponseV1Schema,
  type GenerateRoutesResponseV1,
  type GenerateRoutesRequestV1,
  type RouteType,
} from "@/lib/contracts";
import { HikeMap } from "../map/HikeMap";
import { ResultsPanel, type ResultsStatus } from "../results/ResultsPanel";
import { BoundaryEditor } from "./BoundaryEditor";
import { RangeInput } from "./RangeInput";
import {
  DEFAULT_BUILDER_VALUES,
  type AccessPointOption,
  type Bounds,
  type BuilderValues,
  type RangeField,
} from "./types";
import { buildGenerateRoutesRequest, isPointInsideBounds } from "./validation";

const ROUTE_TYPES: Array<{ id: RouteType; label: string; description: string }> = [
  { id: "loop", label: "Loop", description: "Return without retracing the route." },
  { id: "lollipop", label: "Lollipop", description: "A short shared stem joins a loop." },
  { id: "out-and-back", label: "Out & back", description: "Return along the same trail." },
  { id: "point-to-point", label: "Point to point", description: "Finish at another access point." },
];

function patchRange(
  setValues: React.Dispatch<React.SetStateAction<BuilderValues>>,
  key: keyof Pick<
    BuilderValues,
    "distanceMiles" | "elevationGainFeet" | "maximumElevationFeet" | "steepestSustainedGradePct"
  >,
  next: RangeField,
) {
  setValues((current) => ({ ...current, [key]: next }));
}

export function HikeBuilder() {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [values, setValues] = useState<BuilderValues>(DEFAULT_BUILDER_VALUES);
  const [accessPoints, setAccessPoints] = useState<AccessPointOption[]>([]);
  const [selectedAccessPointId, setSelectedAccessPointId] = useState<string>();
  const [accessState, setAccessState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [accessError, setAccessError] = useState("");
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [generationState, setGenerationState] = useState<"idle" | ResultsStatus>("idle");
  const [generationMessage, setGenerationMessage] = useState("");
  const [generationResponse, setGenerationResponse] = useState<GenerateRoutesResponseV1 | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string>();
  const [mobilePanel, setMobilePanel] = useState<"builder" | "results">("builder");
  const generationControllerRef = useRef<AbortController | null>(null);

  const onBoundsChange = useCallback((next: Bounds | null) => {
    const activeGeneration = generationControllerRef.current;
    generationControllerRef.current = null;
    activeGeneration?.abort();
    setBounds(next);
    setAccessPoints([]);
    setSelectedAccessPointId(undefined);
    setAccessState(next && bboxSchema.safeParse(next).success ? "loading" : "idle");
    setAccessError("");
    setGenerationState("idle");
    setGenerationMessage("");
    setGenerationResponse(null);
    setSelectedRouteId(undefined);
  }, []);
  const onAccessPointSelect = useCallback((id: string) => setSelectedAccessPointId(id), []);

  useEffect(() => {
    if (!bounds || !bboxSchema.safeParse(bounds).success) {
      return;
    }
    const controller = new AbortController();
    const query = new URLSearchParams({
      bbox: bounds.join(","),
      includeUncertainAccess: String(values.includeUncertainAccess),
    });
    void fetch(`/api/packs/fixture-pack/access-points?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Access points could not be loaded.");
        return response.json() as Promise<{ accessPoints?: AccessPointOption[] }>;
      })
      .then((payload) => {
        if (!Array.isArray(payload.accessPoints)) throw new Error("Access-point data was invalid.");
        const inside = payload.accessPoints.filter((point) => isPointInsideBounds(point.lon, point.lat, bounds));
        setAccessPoints(inside);
        setSelectedAccessPointId((selected) => selected && inside.some((point) => point.id === selected) ? selected : undefined);
        setAccessState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAccessPoints([]);
        setAccessState("error");
        setAccessError(error instanceof Error ? error.message : "Access points could not be loaded.");
      });
    return () => controller.abort();
  }, [bounds, values.includeUncertainAccess]);

  useEffect(() => () => {
    const activeGeneration = generationControllerRef.current;
    generationControllerRef.current = null;
    activeGeneration?.abort();
  }, []);

  const boundarySummary = useMemo(() => {
    if (!bounds) return "No boundary drawn";
    return `${bounds[0].toFixed(4)}, ${bounds[1].toFixed(4)} to ${bounds[2].toFixed(4)}, ${bounds[3].toFixed(4)}`;
  }, [bounds]);

  const toggleRouteType = (routeType: RouteType) => {
    setValues((current) => ({
      ...current,
      routeTypes: current.routeTypes.includes(routeType)
        ? current.routeTypes.filter((item) => item !== routeType)
        : [...current.routeTypes, routeType],
    }));
  };

  const generate = async () => {
    const validated = buildGenerateRoutesRequest(values, bounds, selectedAccessPointId);
    if (!validated.success) {
      setValidationErrors(validated.errors);
      setGenerationState("idle");
      return;
    }
    generationControllerRef.current?.abort();
    const controller = new AbortController();
    generationControllerRef.current = controller;
    setValidationErrors([]);
    setGenerationState("loading");
    setGenerationMessage("Generating routes inside your boundary…");
    setGenerationResponse(null);
    setSelectedRouteId(undefined);
    try {
      const response = await fetch("/api/routes/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validated.request satisfies GenerateRoutesRequestV1),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Routes could not be generated. Try a different boundary or constraints.");
      const parsed = generateRoutesResponseV1Schema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The route response was invalid.");
      const exactCount = parsed.data.exact.length;
      const nearCount = parsed.data.nearMisses.length;
      const firstRoute = parsed.data.exact[0] ?? parsed.data.nearMisses[0];
      setGenerationResponse(parsed.data);
      setSelectedRouteId(firstRoute?.id);
      setGenerationMessage(
        exactCount === 0
          ? `No exact matches. ${nearCount} near ${nearCount === 1 ? "match is" : "matches are"} available.`
          : `${exactCount} exact ${exactCount === 1 ? "route" : "routes"} ready.`,
      );
      setGenerationState("done");
      setMobilePanel("results");
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        if (generationControllerRef.current !== controller) return;
        setGenerationMessage("Route generation was cancelled.");
        setGenerationState("cancelled");
        return;
      }
      setGenerationMessage(error instanceof Error ? error.message : "Routes could not be generated.");
      setGenerationState("error");
      setMobilePanel("results");
    } finally {
      if (generationControllerRef.current === controller) generationControllerRef.current = null;
    }
  };

  const cancelGeneration = () => {
    generationControllerRef.current?.abort();
    setGenerationMessage("Route generation was cancelled.");
    setGenerationState("cancelled");
    setMobilePanel("results");
  };

  const generatedRoutes = useMemo(
    () => generationResponse ? [...generationResponse.exact, ...generationResponse.nearMisses] : [],
    [generationResponse],
  );

  return (
    <main className="app-frame">
      <header className="topbar">
        <div>
          <span className="eyebrow">Trail graph route builder</span>
          <h1>Alpine Search</h1>
        </div>
        <div className="pack-status" aria-label="Installed region pack">
          <span className="status-dot" aria-hidden="true" />
          <span><strong>Fixture pack</strong><small>Santa Cruz Mountains preview</small></span>
        </div>
      </header>

      <div className={generationState === "idle" ? "workspace" : "workspace with-results"}>
        <nav className="mobile-panel-nav" aria-label="Workspace panels">
          <button type="button" aria-pressed={mobilePanel === "builder"} onClick={() => setMobilePanel("builder")}>Plan</button>
          <button type="button" aria-pressed={mobilePanel === "results"} disabled={generationState === "idle"} onClick={() => setMobilePanel("results")}>Results{generationResponse ? ` (${generatedRoutes.length})` : ""}</button>
        </nav>
        <aside className={mobilePanel === "builder" ? "builder-panel" : "builder-panel mobile-panel-hidden"} aria-labelledby="builder-title">
          <div className="panel-heading">
            <span className="step-number">01</span>
            <div><p>Plan a hike</p><h2 id="builder-title">Build your route</h2></div>
          </div>

          <section className="builder-section boundary-section" aria-labelledby="boundary-title">
            <div className="section-title"><h3 id="boundary-title">Search boundary</h3><span>Required</span></div>
            <p>Draw a rectangle on the map. It is a hard boundary: generated routes cannot leave it.</p>
            <output className={bounds ? "boundary-summary complete" : "boundary-summary"}>
              <span aria-hidden="true">{bounds ? "✓" : "+"}</span>{boundarySummary}
            </output>
            {bounds ? <BoundaryEditor bounds={bounds} onChange={onBoundsChange} /> : null}
          </section>

          <section className="builder-section" aria-labelledby="access-title">
            <div className="section-title"><h3 id="access-title">Starting access point</h3><span>Optional</span></div>
            <p>Choose a known trailhead, or let the builder choose one inside the boundary.</p>
            {!bounds ? <p className="empty-state">Draw a boundary to find access points.</p> : null}
            {accessState === "loading" ? <p className="loading-state" role="status" aria-live="polite">Loading access points…</p> : null}
            {accessState === "error" ? <p className="error-state" role="alert">{accessError}</p> : null}
            {bounds && accessState === "ready" && accessPoints.length === 0 ? (
              <p className="empty-state" role="status">No known access points are inside this boundary.</p>
            ) : null}
            {accessPoints.length > 0 ? (
              <label className="select-field" htmlFor="access-point">
                Access point
                <select id="access-point" value={selectedAccessPointId ?? ""} onChange={(event) => setSelectedAccessPointId(event.currentTarget.value || undefined)}>
                  <option value="">Choose automatically</option>
                  {accessPoints.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}
                </select>
              </label>
            ) : null}
          </section>

          <section className="builder-section" aria-labelledby="shape-title">
            <div className="section-title"><h3 id="shape-title">Route shapes</h3><span>Choose one or more</span></div>
            <div className="shape-grid">
              {ROUTE_TYPES.map((route) => (
                <label key={route.id} className={values.routeTypes.includes(route.id) ? "shape-option selected" : "shape-option"}>
                  <input type="checkbox" checked={values.routeTypes.includes(route.id)} onChange={() => toggleRouteType(route.id)} />
                  <span><strong>{route.label}</strong><small>{route.description}</small></span>
                </label>
              ))}
            </div>
          </section>

          <section className="builder-section constraints" aria-labelledby="constraints-title">
            <div className="section-title"><h3 id="constraints-title">Physical constraints</h3><span>Min – max</span></div>
            <RangeInput id="distance" label="Distance" unit="miles" optional={false} value={values.distanceMiles} onChange={(next) => patchRange(setValues, "distanceMiles", next)} />
            <RangeInput id="gain" label="Elevation gain" unit="feet" value={values.elevationGainFeet} onChange={(next) => patchRange(setValues, "elevationGainFeet", next)} />
            <RangeInput id="altitude" label="Maximum elevation" unit="feet" value={values.maximumElevationFeet} onChange={(next) => patchRange(setValues, "maximumElevationFeet", next)} />
            <RangeInput id="grade" label="Steepest sustained grade" unit="% over 100 m" value={values.steepestSustainedGradePct} onChange={(next) => patchRange(setValues, "steepestSustainedGradePct", next)} />
          </section>

          <section className="builder-section policy-section" aria-labelledby="policy-title">
            <h3 id="policy-title">Access policy & results</h3>
            <label className="switch-row">
              <span><strong>Include uncertain access</strong><small>Off by default. May include trails without confirmed public access.</small></span>
              <input
                type="checkbox"
                role="switch"
                checked={values.includeUncertainAccess}
                onChange={(event) => {
                  setValues((current) => ({ ...current, includeUncertainAccess: event.currentTarget.checked }));
                  if (bounds) {
                    setAccessPoints([]);
                    setSelectedAccessPointId(undefined);
                    setAccessState("loading");
                    setAccessError("");
                  }
                }}
              />
            </label>
            <div className="count-field">
              <label htmlFor="route-count">Number of routes</label>
              <input id="route-count" type="number" min="1" max="20" step="1" value={values.limit} onChange={(event) => setValues((current) => ({ ...current, limit: event.currentTarget.value }))} />
              <small>1 to 20 alternatives</small>
            </div>
          </section>

          {validationErrors.length > 0 ? (
            <div className="validation-errors" role="alert">
              <strong>Check your route settings:</strong>
              <ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
            </div>
          ) : null}
          <button className="generate-button" type="button" disabled={generationState === "loading"} onClick={() => void generate()}>
            {generationState === "loading" ? "Generating…" : "Generate routes"}
          </button>
          {generationState === "loading" ? <button className="cancel-button" type="button" onClick={cancelGeneration}>Cancel generation</button> : null}
          {generationMessage ? (
            <p className={generationState === "error" ? "generation-status error-state" : "generation-status"} role={generationState === "error" ? "alert" : "status"} aria-live="polite">
              {generationMessage}
            </p>
          ) : null}
        </aside>

        <HikeMap
          bounds={bounds}
          accessPoints={accessPoints}
          selectedAccessPointId={selectedAccessPointId}
          routes={generatedRoutes}
          selectedRouteId={selectedRouteId}
          onBoundsChange={onBoundsChange}
          onAccessPointSelect={onAccessPointSelect}
          onRouteSelect={setSelectedRouteId}
        />
        {generationState !== "idle" ? (
          <ResultsPanel
            status={generationState}
            response={generationResponse}
            message={generationMessage}
            selectedRouteId={selectedRouteId}
            onSelectRoute={setSelectedRouteId}
            mobileVisible={mobilePanel === "results"}
          />
        ) : null}
      </div>
    </main>
  );
}
