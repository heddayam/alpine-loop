"use client";

import { useMemo, useRef, type KeyboardEvent } from "react";
import type {
  GeneratedRouteV2,
  GenerateRoutesResponseV2,
  RouteType,
} from "@/lib/contracts";
import { announceRoutePreview } from "../map/routeTraceOverlay";

export type ResultsStatus = "loading" | "done" | "error" | "cancelled";

type ResultsPanelProps = {
  status: ResultsStatus;
  response: GenerateRoutesResponseV2 | null;
  message?: string;
  selectedRouteId?: string;
  onSelectRoute: (routeId: string) => void;
  mobileVisible?: boolean;
  desktopVisible?: boolean;
};

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

const SHAPE_LABELS: Record<RouteType, string> = {
  loop: "Loop",
  lollipop: "Lollipop",
  "out-and-back": "Out & back",
  "point-to-point": "Point to point",
};

function formatMiles(meters: number) {
  return `${(meters / METERS_PER_MILE).toFixed(1)} mi`;
}

function formatFeet(meters: number) {
  return `${Math.round(meters * FEET_PER_METER).toLocaleString("en-US")} ft`;
}

function formatFreshness(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function trailheadCoordinates(route: GeneratedRouteV2) {
  return `${route.startAccessPoint.lat.toFixed(5)}, ${route.startAccessPoint.lon.toFixed(5)}`;
}

function ElevationProfile({ route }: { route: GeneratedRouteV2 }) {
  const samples = route.elevationSamples;
  if (!samples || samples.length < 2) return null;

  const width = 300;
  const height = 84;
  const padding = 8;
  const distances = samples.map((sample) => sample.distanceMeters);
  const elevations = samples.map((sample) => sample.elevationMeters);
  const minDistance = Math.min(...distances);
  const maxDistance = Math.max(...distances);
  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  const distanceSpan = Math.max(1, maxDistance - minDistance);
  const elevationSpan = Math.max(1, maxElevation - minElevation);
  const points = samples.map((sample) => {
    const x = padding + ((sample.distanceMeters - minDistance) / distanceSpan) * (width - padding * 2);
    const y = height - padding - ((sample.elevationMeters - minElevation) / elevationSpan) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <figure className="elevation-profile">
      <figcaption>Elevation profile</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Elevation profile from ${formatFeet(minElevation)} to ${formatFeet(maxElevation)}`}>
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
        <polyline points={points} />
      </svg>
      <div><span>{formatFeet(minElevation)}</span><span>{formatMiles(maxDistance)}</span><span>{formatFeet(maxElevation)}</span></div>
    </figure>
  );
}

function RouteCard({
  route,
  routeNumber,
  selected,
  buttonRef,
  onSelect,
}: {
  route: GeneratedRouteV2 & { violations?: GenerateRoutesResponseV2["nearMisses"][number]["violations"] };
  routeNumber: number;
  selected: boolean;
  buttonRef: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const detailId = `route-detail-${route.id}`;
  const coordinates = trailheadCoordinates(route);
  const copyCoordinates = () => {
    void navigator.clipboard?.writeText(coordinates).catch(() => undefined);
  };
  return (
    <article
      className={selected ? "route-card selected" : "route-card"}
      aria-labelledby={`route-trails-${route.id} route-${route.id}`}
      onMouseEnter={() => announceRoutePreview(route.id)}
      onMouseLeave={() => announceRoutePreview()}
      onFocusCapture={() => announceRoutePreview(route.id)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) announceRoutePreview();
      }}
    >
      <button
        ref={buttonRef}
        className="route-card-select route-summary"
        type="button"
        aria-pressed={selected}
        aria-expanded={selected}
        aria-controls={selected ? detailId : undefined}
        onClick={onSelect}
      >
        <span className="route-number" aria-hidden="true"><span>{routeNumber}</span></span>
        <span className="route-summary-main">
          <strong id={`route-trails-${route.id}`}>{route.trailNames.length > 0 ? route.trailNames.join(" · ") : "Unnamed trail route"}</strong>
          <small id={`route-${route.id}`}>{SHAPE_LABELS[route.shape]}</small>
        </span>
        <span className="route-summary-metrics">
          <span className="route-summary-stat"><small>Distance</small><strong>{formatMiles(route.distanceMeters)}</strong></span>
          <span className="route-summary-stat"><small>Gain</small><strong>{formatFeet(route.elevationGainMeters)}</strong></span>
          <span className="route-summary-stat"><small>Max grade</small><strong>{route.steepestSustainedGradePct.toFixed(1)}%</strong></span>
        </span>
      </button>

      {selected ? (
        <div className="route-card-detail" id={detailId} role="region" aria-labelledby={`route-trails-${route.id} route-${route.id}`}>
          <ElevationProfile route={route} />
          <button
            type="button"
            className="trailhead-coordinates"
            aria-label={`Copy trailhead coordinates ${coordinates}`}
            title="Copy trailhead coordinates"
            onClick={copyCoordinates}
          >
            <span>Trailhead</span>
            <code>{coordinates}</code>
          </button>

          <details className="route-secondary">
            <summary>
              <span>Route details</span>
              <small>Terrain, access & data</small>
            </summary>
            <div className="route-secondary-content">
              <p className="route-endpoints">
                <span>{route.startAccessPoint.name}</span>
                <span aria-hidden="true">→</span>
                <span>{route.endAccessPoint.name}</span>
              </p>

              {!route.filterMatch.end ? (
                <p className="filter-match-note" role="note"><span aria-hidden="true">ⓘ</span> Finish outside trailhead filter</p>
              ) : null}

              {route.violations?.length ? (
                <div className="violation-list" aria-label="Near-miss constraints">
                  <strong>Outside requested constraints</strong>
                  <ul>{route.violations.map((violation) => <li key={violation.constraint}>{violation.constraint.replaceAll("-", " ")}: {violation.value.toFixed(1)} (requested {violation.min.toFixed(1)}–{violation.max.toFixed(1)})</li>)}</ul>
                </div>
              ) : null}

              <dl className="route-secondary-metrics">
                <div><dt>Elevation loss</dt><dd>{formatFeet(route.elevationLossMeters)}</dd></div>
                <div><dt>Low point</dt><dd>{formatFeet(route.minimumElevationMeters)}</dd></div>
                <div><dt>High point</dt><dd>{formatFeet(route.maximumElevationMeters)}</dd></div>
                <div><dt>Repeated trail</dt><dd>{Math.round(route.repeatedEdgeFraction * 100)}%</dd></div>
              </dl>

              <footer className="route-source">
                <span>Source confidence: <strong>{route.source.confidence}</strong></span>
                <span>Data current {formatFreshness(route.source.freshness)}</span>
                <span>Sources: {route.source.sourceIds.join(", ")}</span>
              </footer>
            </div>
          </details>
        </div>
      ) : null}
    </article>
  );
}

export function ResultsPanel({
  status,
  response,
  message,
  selectedRouteId,
  onSelectRoute,
  mobileVisible = true,
  desktopVisible = true,
}: ResultsPanelProps) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelClassName = [
    "results-panel",
    mobileVisible ? "" : "mobile-panel-hidden",
    desktopVisible ? "" : "desktop-panel-hidden",
  ].filter(Boolean).join(" ");
  const routes = useMemo(
    () => response ? [...response.exact, ...response.nearMisses] : [],
    [response],
  );

  const handleKeyboardNavigation = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || routes.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, routes.findIndex((route) => route.id === selectedRouteId));
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = routes.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % routes.length;
    else nextIndex = (currentIndex - 1 + routes.length) % routes.length;
    const nextRoute = routes[nextIndex];
    if (!nextRoute) return;
    onSelectRoute(nextRoute.id);
    cardRefs.current[nextIndex]?.focus();
  };

  if (status === "loading") {
    return (
      <aside className={panelClassName} aria-labelledby="results-title">
        <div className="results-heading"><h2 id="results-title">Results</h2></div>
        <p className="results-state loading-state" role="status" aria-live="polite">Searching eligible trailheads and generating routes…</p>
      </aside>
    );
  }

  if (status === "error") {
    return (
      <aside className={panelClassName} aria-labelledby="results-title">
        <div className="results-heading"><h2 id="results-title">Results</h2></div>
        <div className="results-state error-state" role="alert"><strong>Routes could not be generated.</strong><span>{message ?? "Try a different trailhead filter or constraints."}</span></div>
      </aside>
    );
  }

  if (status === "cancelled") {
    return (
      <aside className={panelClassName} aria-labelledby="results-title">
        <div className="results-heading"><h2 id="results-title">Results</h2></div>
        <div className="results-state cancelled-state" role="status" aria-live="polite"><strong>No routes were changed.</strong><span>Adjust your settings or generate again when you’re ready.</span></div>
      </aside>
    );
  }

  if (!response) return null;

  const total = routes.length;

  return (
    <aside className={panelClassName} aria-labelledby="results-title">
      <div className="results-heading">
        <h2 id="results-title">Results</h2>
      </div>

      {total === 0 ? (
        <div className="no-results" role="status">
          <strong>No routes found from eligible trailheads.</strong>
          <span>Try a broader trailhead filter, a wider distance range, or include uncertain access.</span>
        </div>
      ) : (
        <div className="route-lists" onKeyDown={handleKeyboardNavigation} aria-label="Generated routes">
          <section className="result-section" aria-labelledby="exact-results-title">
            <div className="result-section-heading">
              <h3 id="exact-results-title">Exact matches</h3>
              <span>{response.exact.length}</span>
            </div>
            {response.exact.map((route, index) => (
              <RouteCard
                key={route.id}
                route={route}
                routeNumber={index + 1}
                selected={route.id === selectedRouteId}
                buttonRef={(node) => { cardRefs.current[index] = node; }}
                onSelect={() => onSelectRoute(route.id)}
              />
            ))}
          </section>

          {response.nearMisses.length > 0 ? (
            <section className="result-section near-misses" aria-labelledby="near-results-title">
              <div className="result-section-heading"><h3 id="near-results-title">Near misses</h3><span>{response.nearMisses.length}</span></div>
              {response.nearMisses.map((route, index) => (
                <RouteCard
                  key={route.id}
                  route={route}
                  routeNumber={response.exact.length + index + 1}
                  selected={route.id === selectedRouteId}
                  buttonRef={(node) => { cardRefs.current[response.exact.length + index] = node; }}
                  onSelect={() => onSelectRoute(route.id)}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}

      <details className="diagnostics">
        <summary>Search diagnostics</summary>
        <p>{response.resolvedAccessFilter.label}</p>
        <dl>
          <div><dt>Elapsed</dt><dd>{Math.round(response.diagnostics.elapsedMs).toLocaleString("en-US")} ms</dd></div>
          <div><dt>States explored</dt><dd>{response.diagnostics.expandedStates.toLocaleString("en-US")}</dd></div>
          <div><dt>Candidates</dt><dd>{response.diagnostics.candidateCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Eligible starts</dt><dd>{response.diagnostics.eligibleAccessPointCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Searched starts</dt><dd>{response.diagnostics.searchedAccessPointCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Graph queries</dt><dd>{response.diagnostics.graphQueryCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Max loaded edges</dt><dd>{response.diagnostics.maximumLoadedDirectedEdges.toLocaleString("en-US")}</dd></div>
          <div><dt>Request ID</dt><dd>{response.requestId}</dd></div>
        </dl>
        {response.diagnostics.truncationReasons.length ? <p><strong>Search limits:</strong> {response.diagnostics.truncationReasons.join(" · ")}</p> : null}
        {response.diagnostics.shortfallReasons.length ? <p><strong>Shortfall:</strong> {response.diagnostics.shortfallReasons.join(" · ")}</p> : null}
      </details>
    </aside>
  );
}
