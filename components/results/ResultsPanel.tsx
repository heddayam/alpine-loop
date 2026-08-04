"use client";

import { useMemo, useRef, type KeyboardEvent } from "react";
import type {
  ConstraintViolation,
  GeneratedRoute,
  GenerateRoutesResponseV1,
  RouteType,
} from "@/lib/contracts";

export type ResultsStatus = "loading" | "done" | "error" | "cancelled";

type ResultsPanelProps = {
  status: ResultsStatus;
  response: GenerateRoutesResponseV1 | null;
  message?: string;
  selectedRouteId?: string;
  onSelectRoute: (routeId: string) => void;
  mobileVisible?: boolean;
};

type DisplayRoute = GeneratedRoute & { violations?: ConstraintViolation[] };

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

const SHAPE_LABELS: Record<RouteType, string> = {
  loop: "Loop",
  lollipop: "Lollipop",
  "out-and-back": "Out & back",
  "point-to-point": "Point to point",
};

const VIOLATION_LABELS: Record<ConstraintViolation["constraint"], string> = {
  distance: "Distance",
  "elevation-gain": "Elevation gain",
  "maximum-elevation": "Maximum elevation",
  "steepest-sustained-grade": "Steepest sustained grade",
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

function humanizeReason(reason: string) {
  const labels: Record<string, string> = {
    deadline: "time budget reached",
    "maximum-directed-edges": "trail graph was too large",
    "maximum-expanded-states": "search-state budget reached",
    "maximum-raw-candidates": "candidate budget reached",
    aborted: "request was cancelled",
  };
  return labels[reason] ?? reason.replaceAll("-", " ");
}

function violationValue(violation: ConstraintViolation, value: number) {
  if (violation.constraint === "distance") return `${value.toFixed(1)} mi`;
  if (violation.constraint === "steepest-sustained-grade") return `${value.toFixed(1)}%`;
  return `${Math.round(value).toLocaleString("en-US")} ft`;
}

function ElevationProfile({ route }: { route: GeneratedRoute }) {
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
  selected,
  buttonRef,
  onSelect,
}: {
  route: DisplayRoute;
  selected: boolean;
  buttonRef: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  return (
    <article className={selected ? "route-card selected" : "route-card"} aria-labelledby={`route-${route.id}`}>
      <button
        ref={buttonRef}
        className="route-card-select"
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="route-swatch" aria-hidden="true" />
        <span>
          <strong id={`route-${route.id}`}>{SHAPE_LABELS[route.shape]}</strong>
          <small>{route.trailNames.length > 0 ? route.trailNames.join(" · ") : "Unnamed trail route"}</small>
        </span>
        <span className="selection-label">{selected ? "Selected" : "View"}</span>
      </button>

      <dl className="route-metrics">
        <div><dt>Distance</dt><dd>{formatMiles(route.distanceMeters)}</dd></div>
        <div><dt>Gain</dt><dd>{formatFeet(route.elevationGainMeters)}</dd></div>
        <div><dt>High point</dt><dd>{formatFeet(route.maximumElevationMeters)}</dd></div>
        <div><dt>Max grade</dt><dd>{route.steepestSustainedGradePct.toFixed(1)}%</dd></div>
      </dl>

      <p className="route-endpoints">
        <span>{route.startAccessPoint.name}</span>
        <span aria-hidden="true">→</span>
        <span>{route.endAccessPoint.name}</span>
      </p>

      <details className="route-details">
        <summary>More route metrics</summary>
        <dl>
          <div><dt>Elevation loss</dt><dd>{formatFeet(route.elevationLossMeters)}</dd></div>
          <div><dt>Low point</dt><dd>{formatFeet(route.minimumElevationMeters)}</dd></div>
          <div><dt>Repeated trail</dt><dd>{Math.round(route.repeatedEdgeFraction * 100)}%</dd></div>
        </dl>
      </details>

      {route.violations && route.violations.length > 0 ? (
        <div className="route-violations" aria-label="Violated constraints">
          <strong>Outside your constraints</strong>
          <ul>
            {route.violations.map((violation) => (
              <li key={violation.constraint}>
                {VIOLATION_LABELS[violation.constraint]}: {violationValue(violation, violation.value)}; requested {violationValue(violation, violation.min)}–{violationValue(violation, violation.max)} (off by {violationValue(violation, violation.delta)})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {route.warnings.length > 0 ? (
        <div className="route-warnings" aria-label="Route warnings">
          <strong>Warnings</strong>
          <ul>{route.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      ) : null}

      <ElevationProfile route={route} />

      <footer className="route-source">
        <span>Source confidence: <strong>{route.source.confidence}</strong></span>
        <span>Data current {formatFreshness(route.source.freshness)}</span>
        <span>Sources: {route.source.sourceIds.join(", ")}</span>
      </footer>
    </article>
  );
}

export function ResultsPanel({ status, response, message, selectedRouteId, onSelectRoute, mobileVisible = true }: ResultsPanelProps) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
      <aside className={mobileVisible ? "results-panel" : "results-panel mobile-panel-hidden"} aria-labelledby="results-title">
        <div className="results-heading"><p>Route alternatives</p><h2 id="results-title">Searching the graph</h2></div>
        <p className="results-state loading-state" role="status" aria-live="polite">Generating routes inside your hard boundary…</p>
      </aside>
    );
  }

  if (status === "error") {
    return (
      <aside className={mobileVisible ? "results-panel" : "results-panel mobile-panel-hidden"} aria-labelledby="results-title">
        <div className="results-heading"><p>Route alternatives</p><h2 id="results-title">Generation failed</h2></div>
        <div className="results-state error-state" role="alert"><strong>Routes could not be generated.</strong><span>{message ?? "Try a different boundary or constraints."}</span></div>
      </aside>
    );
  }

  if (status === "cancelled") {
    return (
      <aside className={mobileVisible ? "results-panel" : "results-panel mobile-panel-hidden"} aria-labelledby="results-title">
        <div className="results-heading"><p>Route alternatives</p><h2 id="results-title">Search cancelled</h2></div>
        <div className="results-state cancelled-state" role="status" aria-live="polite"><strong>No routes were changed.</strong><span>Adjust your settings or generate again when you’re ready.</span></div>
      </aside>
    );
  }

  if (!response) return null;

  const total = routes.length;
  const isPartial = response.diagnostics.exhausted || total < response.requested;
  const reasons = response.diagnostics.truncationReasons.map(humanizeReason);

  return (
    <aside className={mobileVisible ? "results-panel" : "results-panel mobile-panel-hidden"} aria-labelledby="results-title">
      <div className="results-heading">
        <p>Route alternatives</p>
        <h2 id="results-title">Explore results</h2>
        <span>{response.exact.length} exact · {response.nearMisses.length} near miss{response.nearMisses.length === 1 ? "" : "es"}</span>
      </div>

      <p className="conditions-warning">Planning aid only. Verify current trail conditions and access before hiking.</p>

      {isPartial ? (
        <div className="partial-notice" role="status" aria-live="polite">
          <strong>{response.diagnostics.exhausted ? "Search stopped at its safety budget." : `Found fewer than the ${response.requested} routes requested.`}</strong>
          <span>{reasons.length > 0 ? `Reason: ${reasons.join(", ")}.` : `${total} alternatives were returned; ${response.exact.length} met every constraint.`}</span>
        </div>
      ) : null}

      {total === 0 ? (
        <div className="no-results" role="status">
          <strong>No routes found inside this boundary.</strong>
          <span>Try a larger rectangle, a wider distance range, or include uncertain access.</span>
        </div>
      ) : (
        <div className="route-lists" onKeyDown={handleKeyboardNavigation} aria-label="Generated routes">
          <section className="result-section" aria-labelledby="exact-results-title">
            <div className="result-section-heading"><h3 id="exact-results-title">Exact matches</h3><span>{response.exact.length}</span></div>
            {response.exact.length === 0 ? <p className="no-exact">No route met every constraint. Near misses are listed separately below.</p> : null}
            {response.exact.map((route, index) => (
              <RouteCard
                key={route.id}
                route={route}
                selected={route.id === selectedRouteId}
                buttonRef={(node) => { cardRefs.current[index] = node; }}
                onSelect={() => onSelectRoute(route.id)}
              />
            ))}
          </section>

          {response.nearMisses.length > 0 ? (
            <section className="result-section near-misses" aria-labelledby="near-results-title">
              <div className="result-section-heading"><h3 id="near-results-title">Near misses</h3><span>{response.nearMisses.length}</span></div>
              <p>These routes do not meet every constraint. Review each disclosed violation.</p>
              {response.nearMisses.map((route, index) => (
                <RouteCard
                  key={route.id}
                  route={route}
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
        <dl>
          <div><dt>Elapsed</dt><dd>{Math.round(response.diagnostics.elapsedMs).toLocaleString("en-US")} ms</dd></div>
          <div><dt>States explored</dt><dd>{response.diagnostics.expandedStates.toLocaleString("en-US")}</dd></div>
          <div><dt>Candidates</dt><dd>{response.diagnostics.candidateCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Request ID</dt><dd>{response.requestId}</dd></div>
        </dl>
      </details>
    </aside>
  );
}
