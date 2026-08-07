"use client";

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type {
  GeneratedClosedRouteV3,
  GenerateClosedRoutesResponseV3,
} from "@/lib/contracts";
import { announceRoutePreview } from "../map/routeTraceOverlay";

export type ResultsStatus = "loading" | "done" | "error" | "cancelled";

type ResultsPanelProps = {
  status: ResultsStatus;
  response: GenerateClosedRoutesResponseV3 | null;
  message?: string;
  selectedRouteId?: string;
  onSelectRoute: (routeId: string) => void;
  mobileVisible?: boolean;
  desktopVisible?: boolean;
  hoveredRouteId?: string;
  nearMissesOpen?: boolean;
  onToggleNearMisses?: (open: boolean) => void;
  pagination?: { hasNext: boolean; loading: boolean; onNext: () => void };
};

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

const TOPOLOGY_LABELS: Record<GeneratedClosedRouteV3["topology"]["kind"], string> = {
  "simple-loop": "Simple loop",
  lollipop: "Lollipop",
  "figure-eight": "Figure-eight",
  "chained-loops": "Chained loops",
  "complex-closed": "Complex closed route",
};

function miles(meters: number) {
  return (meters / METERS_PER_MILE).toFixed(1);
}

function feet(meters: number) {
  return Math.round(meters * FEET_PER_METER).toLocaleString("en-US");
}

function formatMiles(meters: number) {
  return `${miles(meters)} mi`;
}

function formatFeet(meters: number) {
  return `${feet(meters)} ft`;
}

function formatFreshness(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function topologySummary(route: GeneratedClosedRouteV3) {
  const topology = route.topology;
  return [
    TOPOLOGY_LABELS[topology.kind],
    ...(topology.repeatedTrailFraction > 0 ? [`${Math.round(topology.repeatedTrailFraction * 100)}% repeated`] : []),
    ...(topology.sharedStemDistanceMeters > 0 ? [`${formatMiles(topology.sharedStemDistanceMeters)} stem`] : []),
  ].join(" · ");
}

function formatViolationValue(constraint: GenerateClosedRoutesResponseV3["nearMisses"][number]["violations"][number]["constraint"], value: number) {
  if (constraint === "distance" || constraint === "shared-stem") return formatMiles(value);
  if (constraint === "elevation-gain" || constraint === "maximum-elevation") return formatFeet(value);
  return `${value.toFixed(1)}%`;
}

function trailheadCoordinates(route: GeneratedClosedRouteV3) {
  return `${route.startAccessPoint.lat.toFixed(5)}, ${route.startAccessPoint.lon.toFixed(5)}`;
}

function ElevationProfile({ route }: { route: GeneratedClosedRouteV3 }) {
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
  hovered,
  buttonRef,
  onSelect,
}: {
  route: GeneratedClosedRouteV3 & { violations?: GenerateClosedRoutesResponseV3["nearMisses"][number]["violations"] };
  routeNumber: number;
  selected: boolean;
  hovered: boolean;
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
      className={["route-card", selected ? "selected" : "", hovered ? "hovered" : ""].filter(Boolean).join(" ")}
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
          <small id={`route-${route.id}`}>{topologySummary(route)}</small>
        </span>
        <span className="route-summary-metrics">
          <span title="Distance"><strong>{miles(route.distanceMeters)}</strong> mi</span>
          <span title="Elevation gain"><span aria-hidden="true">↑</span> <strong>{feet(route.elevationGainMeters)}</strong> ft</span>
          {route.gradeExperience ? (
            <span title={`Climb p90 · ${route.gradeExperience.steepClimbingSharePct.toFixed(0)}% of climbing above ${route.gradeExperience.steepThresholdPct}% · longest ${(route.gradeExperience.longestSteepClimbMeters / 1609.344).toFixed(1)} mi · descent p90 ${route.gradeExperience.descentP90Pct.toFixed(1)}%`}>
              <strong>{route.gradeExperience.climbP90Pct.toFixed(1)}%</strong> climb · {route.gradeExperience.steepClimbingSharePct.toFixed(0)}% steep · {(route.gradeExperience.longestSteepClimbMeters / 1609.344).toFixed(1)} mi run
            </span>
          ) : <span title="Steepest sustained grade"><strong>{route.steepestSustainedGradePct.toFixed(1)}%</strong> grade</span>}
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
              <small>Terrain, access &amp; data</small>
            </summary>
            <div className="route-secondary-content">
              <p className="route-endpoints"><span>{route.startAccessPoint.name}</span><span aria-hidden="true">↻</span><span>same trailhead</span></p>

              {route.violations?.length ? (
                <div className="violation-list" aria-label="Near-miss constraints">
                  <strong>Outside requested constraints</strong>
                  <ul>{route.violations.map((violation) => <li key={violation.constraint}>{violation.constraint.replaceAll("-", " ")}: {formatViolationValue(violation.constraint, violation.value)} (requested {formatViolationValue(violation.constraint, violation.min)}–{formatViolationValue(violation.constraint, violation.max)})</li>)}</ul>
                </div>
              ) : null}

              <dl className="route-secondary-metrics">
                <div><dt>Elevation loss</dt><dd>{formatFeet(route.elevationLossMeters)}</dd></div>
                <div><dt>Low point</dt><dd>{formatFeet(route.minimumElevationMeters)}</dd></div>
                <div><dt>High point</dt><dd>{formatFeet(route.maximumElevationMeters)}</dd></div>
                <div><dt>Repeated trail</dt><dd>{Math.round(route.topology.repeatedTrailFraction * 100)}%</dd></div>
                {route.topology.sharedStemDistanceMeters > 0 ? <div><dt>Shared stem</dt><dd>{formatMiles(route.topology.sharedStemDistanceMeters)}</dd></div> : null}
                <div><dt>Cycle blocks</dt><dd>{route.topology.cycleBlockCount.toLocaleString("en-US")}</dd></div>
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
  hoveredRouteId,
  nearMissesOpen = false,
  onToggleNearMisses,
  pagination,
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

  // Hovering a route on the map brings its card into view, so the two halves
  // of the workspace always agree on what is being pointed at.
  useEffect(() => {
    if (!hoveredRouteId) return;
    const index = routes.findIndex((route) => route.id === hoveredRouteId);
    if (index < 0) return;
    cardRefs.current[index]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [hoveredRouteId, routes]);

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
        <div className="results-state error-state" role="alert"><strong>Routes could not be generated.</strong><span>{message ?? "Try a different area or looser constraints."}</span></div>
      </aside>
    );
  }

  if (status === "cancelled") {
    return (
      <aside className={panelClassName} aria-labelledby="results-title">
        <div className="results-heading"><h2 id="results-title">Results</h2></div>
        <div className="results-state cancelled-state" role="status" aria-live="polite"><strong>No routes were changed.</strong><span>Adjust your settings and search again.</span></div>
      </aside>
    );
  }

  if (!response) return null;

  const total = routes.length;
  const exactShortfall = response.exact.length < response.requested;
  const budgetLimited = response.diagnostics.hardTruncationReasons.length > 0;
  const shortfallReasons = [
    ...response.diagnostics.nonBudgetShortfallReasons,
    ...response.diagnostics.shortfallReasons,
  ];

  return (
    <aside className={panelClassName} aria-labelledby="results-title">
      <div className="results-heading">
        <h2 id="results-title">Results</h2>
        <span className="count">{total} route{total === 1 ? "" : "s"}</span>
      </div>

      {exactShortfall ? (
        <div className="results-state" role="status" aria-live="polite">
          <strong>{response.exact.length} of {response.requested} requested exact routes found.</strong>
          <span>{budgetLimited
            ? "The effort limit stopped the search early."
            : response.diagnostics.exhausted
              ? "The search was exhausted before finding enough exact matches."
              : "Fewer exact matches than requested."} Near misses are listed separately.</span>
        </div>
      ) : null}

      {total === 0 ? (
        <div className="no-results" role="status">
          <strong>No routes found.</strong>
          <span>Widen the distance range, choose a broader area, or include uncertain access in Settings.</span>
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
                hovered={route.id === hoveredRouteId}
                buttonRef={(node) => { cardRefs.current[index] = node; }}
                onSelect={() => onSelectRoute(route.id)}
              />
            ))}
          </section>

          {response.nearMisses.length > 0 ? (
            /* Near misses stay folded away while there are exact matches to
               read; with none, they are the only thing left to look at. */
            <details className="result-section near-misses" open={nearMissesOpen} aria-labelledby="near-results-title" onToggle={(event) => onToggleNearMisses?.(event.currentTarget.open)}>
              <summary className="result-section-heading"><h3 id="near-results-title">Near misses</h3><span>{response.nearMisses.length}</span></summary>
              {response.nearMisses.map((route, index) => (
                <RouteCard
                  key={route.id}
                  route={route}
                  routeNumber={response.exact.length + index + 1}
                  selected={route.id === selectedRouteId}
                  hovered={route.id === hoveredRouteId}
                  buttonRef={(node) => { cardRefs.current[response.exact.length + index] = node; }}
                  onSelect={() => onSelectRoute(route.id)}
                />
              ))}
            </details>
          ) : null}
        </div>
      )}

      {pagination ? (
        <nav className="results-pagination" aria-label="Batch result pages">
          <span>50 per page</span>
          <button type="button" className="btn" disabled={!pagination.hasNext || pagination.loading} onClick={pagination.onNext}>
            {pagination.loading ? "Loading…" : pagination.hasNext ? "Next 50 routes" : "Last page"}
          </button>
        </nav>
      ) : null}

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
          <div><dt>Cycle-feasible starts</dt><dd>{response.diagnostics.feasibleAccessPointCount.toLocaleString("en-US")}</dd></div>
          <div><dt>No-cycle starts</dt><dd>{response.diagnostics.noCycleAccessPointCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Attachment groups probed</dt><dd>{response.diagnostics.probedAttachmentGroupCount.toLocaleString("en-US")} / {response.diagnostics.attachmentGroupCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Groups deeply searched</dt><dd>{response.diagnostics.deeplySearchedAttachmentGroupCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Cycle primitives</dt><dd>{response.diagnostics.cyclePrimitiveCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Composed candidates</dt><dd>{response.diagnostics.composedCandidateCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Request ID</dt><dd>{response.requestId}</dd></div>
        </dl>
        {response.diagnostics.hardTruncationReasons.length ? <p><strong>Hard search limits:</strong> {response.diagnostics.hardTruncationReasons.join(" · ")}</p> : null}
        {response.diagnostics.truncationReasons.length ? <p><strong>Search limits:</strong> {response.diagnostics.truncationReasons.join(" · ")}</p> : null}
        {shortfallReasons.length ? <p><strong>Shortfall:</strong> {[...new Set(shortfallReasons)].join(" · ")}</p> : null}
      </details>
    </aside>
  );
}
