"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  GeneratedClosedRouteV3,
  ConstraintViolationV3,
} from "@/lib/contracts";
import { COPY_FEEDBACK_MS, copyTextToClipboard, copyTextWithDocument } from "../clipboard";
import type { RouteResults } from "./types";

export type ResultsStatus = "loading" | "done" | "error" | "cancelled";

type ResultsPanelProps = {
  status: ResultsStatus;
  results: RouteResults | null;
  message?: string;
  selectedRouteId?: string;
  onSelectRoute: (routeId: string) => void;
  onHoverRoute: (routeId: string | undefined) => void;
  mobileVisible?: boolean;
  desktopVisible?: boolean;
  hoveredRouteId?: string;
  selectedSegmentId?: string;
  hoveredSegmentId?: string;
  onSelectSegment?: (segmentId: string) => void;
  onHoverSegment?: (segmentId?: string) => void;
  nearMissesOpen?: boolean;
  onToggleNearMisses?: (open: boolean) => void;
  pagination?: { hasNext: boolean; loading: boolean; onNext: () => void };
  onClose?: () => void;
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

function routeHeading(route: GeneratedClosedRouteV3) {
  const longestNamedSegment = [...(route.trailSegments ?? [])]
    .filter((segment): segment is typeof segment & { name: string } => Boolean(segment.name))
    .sort((left, right) => right.distanceMeters - left.distanceMeters || left.name.localeCompare(right.name))[0];
  const parts = [route.startAccessPoint.name, longestNamedSegment?.name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const key = (part: string) => part.toLowerCase();
  return parts
    .filter((part, index) => parts.findIndex((other) => key(other) === key(part)) === index)
    .join(" · ");
}

function trailheadCoordinates(route: GeneratedClosedRouteV3) {
  return `${route.startAccessPoint.lat.toFixed(5)}, ${route.startAccessPoint.lon.toFixed(5)}`;
}

function segmentConditionSearch(
  segment: NonNullable<GeneratedClosedRouteV3["trailSegments"]>[number],
) {
  const [lon, lat] = segment.geometry.coordinates[0] ?? [];
  const query = segment.name
    ? `${segment.name} conditions`
    : typeof lon === "number" && typeof lat === "number"
      ? `trail conditions near ${lat.toFixed(5)}, ${lon.toFixed(5)}`
      : "trail conditions";
  return {
    href: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    label: segment.name
      ? `Search Google for ${segment.name} conditions`
      : "Search Google for conditions near this unnamed trail segment",
  };
}

function ResultsHeading({ total, onClose }: { total?: number; onClose?: () => void }) {
  return (
    <div className="results-heading">
      <h2 id="results-title">Results</h2>
      <div className="results-heading-actions">
        {total !== undefined ? <span className="count">{total} route{total === 1 ? "" : "s"}</span> : null}
        {onClose ? <button type="button" className="settings-close" aria-label="Clear results" onClick={onClose}>×</button> : null}
      </div>
    </div>
  );
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
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Elevation profile from ${formatFeet(minElevation)} to ${formatFeet(maxElevation)}`}>
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
  segmentButtonRef,
  onSelect,
  onHover,
  selectedSegmentId,
  hoveredSegmentId,
  onSelectSegment,
  onHoverSegment,
  regionLabel,
}: {
  route: GeneratedClosedRouteV3 & { violations?: ConstraintViolationV3[] };
  routeNumber: number;
  selected: boolean;
  hovered: boolean;
  buttonRef: (node: HTMLButtonElement | null) => void;
  segmentButtonRef: (segmentId: string, node: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onHover: (routeId: string | undefined) => void;
  selectedSegmentId?: string;
  hoveredSegmentId?: string;
  onSelectSegment?: (segmentId: string) => void;
  onHoverSegment?: (segmentId?: string) => void;
  regionLabel?: string;
}) {
  const detailId = `route-detail-${route.id}`;
  const coordinates = trailheadCoordinates(route);
  const heading = routeHeading(route);
  const [coordinateCopyStatus, setCoordinateCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const coordinateCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coordinateCopyAttemptRef = useRef(0);
  useEffect(() => () => {
    coordinateCopyAttemptRef.current += 1;
    if (coordinateCopyTimerRef.current) clearTimeout(coordinateCopyTimerRef.current);
  }, []);
  // A region label that just restates the heading is noise, not context.
  const showRegionLabel = Boolean(regionLabel) && regionLabel?.trim().toLowerCase() !== heading.trim().toLowerCase();
  const violated = new Set(route.violations?.map(({ constraint }) => constraint) ?? []);
  const gradeViolated = [
    "steepest-sustained-grade",
    "climb-p90-grade",
    "steep-climbing-share",
    "longest-steep-climb",
    "descent-p90-grade",
  ].some((constraint) => violated.has(constraint as ConstraintViolationV3["constraint"]));
  const warningClass = (active: boolean) => active ? "near-match-stat" : undefined;
  const copyCoordinates = () => {
    const attempt = ++coordinateCopyAttemptRef.current;
    void copyTextToClipboard(
      coordinates,
      navigator.clipboard,
      (value) => copyTextWithDocument(value, document),
    ).then((copied) => {
      if (attempt !== coordinateCopyAttemptRef.current) return;
      setCoordinateCopyStatus(copied ? "copied" : "failed");
      if (coordinateCopyTimerRef.current) clearTimeout(coordinateCopyTimerRef.current);
      coordinateCopyTimerRef.current = setTimeout(() => {
        coordinateCopyTimerRef.current = null;
        setCoordinateCopyStatus("idle");
      }, COPY_FEEDBACK_MS);
    });
  };
  return (
    <article
      className={["route-card", selected ? "selected" : "", hovered ? "hovered" : ""].filter(Boolean).join(" ")}
      aria-labelledby={`route-heading-${route.id}`}
      onMouseEnter={() => onHover(route.id)}
      onMouseLeave={() => onHover(undefined)}
      onFocusCapture={() => onHover(route.id)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHover(undefined);
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
        {/* Metrics lead the card: distance, climb, and grade are what an
            expert scans down the list, so names read as the caption. */}
        <span className="route-summary-metrics">
          <span className={warningClass(violated.has("distance"))} title="Distance"><strong>{miles(route.distanceMeters)}</strong> mi</span>
          <span className={warningClass(violated.has("elevation-gain"))} title="Elevation gain"><span aria-hidden="true">↑</span> <strong>{feet(route.elevationGainMeters)}</strong> ft</span>
          {route.gradeExperience ? (
            <span className={["route-grade-metrics", warningClass(gradeViolated)].filter(Boolean).join(" ")} title={`90% of uphill 100 m sections are ${route.gradeExperience.climbP90Pct.toFixed(0)}% grade or less · ${route.gradeExperience.steepClimbingSharePct.toFixed(0)}% of uphill distance is at least ${route.gradeExperience.steepThresholdPct}% grade · longest uninterrupted steep section ${(route.gradeExperience.longestSteepClimbMeters / 1609.344).toFixed(1)} mi · downhill p90 ${route.gradeExperience.descentP90Pct.toFixed(0)}%`}>
              <span>↑P90 <strong>{route.gradeExperience.climbP90Pct.toFixed(0)}%</strong></span>
              <span>≥{route.gradeExperience.steepThresholdPct}% <strong>{route.gradeExperience.steepClimbingSharePct.toFixed(0)}%</strong></span>
            </span>
          ) : <span className={warningClass(gradeViolated)} title="Steepest sustained grade"><strong>{route.steepestSustainedGradePct.toFixed(1)}%</strong> grade</span>}
        </span>
        <span className="route-summary-main">
          {showRegionLabel ? <span className="route-region-label">{regionLabel}</span> : null}
          <strong id={`route-heading-${route.id}`}>{heading}</strong>
        </span>
      </button>

      {selected ? (
        <div className="route-card-detail" id={detailId} role="region" aria-labelledby={`route-heading-${route.id}`}>
          <ElevationProfile route={route} />
          <button
            type="button"
            className="trailhead-coordinates"
            aria-label={`Copy trailhead coordinates ${coordinates}`}
            title="Copy trailhead coordinates"
            onClick={copyCoordinates}
          >
            <span className="trailhead-coordinate-label">
              <svg className="trailhead-coordinate-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
                <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1" />
              </svg>
              <span>Trailhead</span>
            </span>
            {coordinateCopyStatus === "idle"
              ? <code>{coordinates}</code>
              : <span className={`trailhead-coordinate-feedback ${coordinateCopyStatus}`}>{coordinateCopyStatus === "copied" ? "Copied" : "Couldn’t copy"}</span>}
            <span className="visually-hidden" aria-live="polite">
              {coordinateCopyStatus === "copied" ? "Trailhead coordinates copied" : coordinateCopyStatus === "failed" ? "Trailhead coordinates could not be copied" : ""}
            </span>
          </button>

          {route.trailSegments?.length ? (
            <section className="trail-segment-inspector" aria-label="Trail segments">
              <ol className="trail-segment-list">
                {route.trailSegments.map((segment) => {
                  const search = segmentConditionSearch(segment);
                  const active = segment.id === selectedSegmentId;
                  const hovered = segment.id === hoveredSegmentId;
                  return (
                    <li key={segment.id}>
                      <button
                        ref={(node) => segmentButtonRef(segment.id, node)}
                        type="button"
                        className={["trail-segment-row", active ? "selected" : "", hovered ? "hovered" : ""].filter(Boolean).join(" ")}
                        aria-pressed={active}
                        onClick={() => onSelectSegment?.(segment.id)}
                        onMouseEnter={() => onHoverSegment?.(segment.id)}
                        onMouseLeave={() => onHoverSegment?.(undefined)}
                        onFocus={() => onHoverSegment?.(segment.id)}
                        onBlur={() => onHoverSegment?.(undefined)}
                      >
                        {/* Length leads the row: it is the only number that
                            distinguishes one segment from the next, and the
                            list order already carries the sequence. */}
                        <span className="trail-segment-distance">{formatMiles(segment.distanceMeters)}</span>
                        <span className={["trail-segment-name", segment.name ? "" : "unnamed"].filter(Boolean).join(" ")}>
                          {segment.name ?? "Unnamed trail"}
                        </span>
                      </button>
                      <a
                        className="trail-segment-search"
                        href={search.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={search.label}
                        title="Search trail conditions"
                        onMouseEnter={() => onHoverSegment?.(segment.id)}
                        onMouseLeave={() => onHoverSegment?.(undefined)}
                        onFocus={() => onHoverSegment?.(segment.id)}
                        onBlur={() => onHoverSegment?.(undefined)}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                          <circle cx="6.75" cy="6.75" r="4.25" />
                          <path d="m10 10 3.5 3.5" />
                        </svg>
                      </a>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          <details className="route-secondary">
            <summary>Details</summary>
            <div className="route-secondary-content">
              <dl className="route-secondary-metrics">
                <div><dt>Route shape</dt><dd>{TOPOLOGY_LABELS[route.topology.kind]}</dd></div>
                <div><dt>Elevation loss</dt><dd>{formatFeet(route.elevationLossMeters)}</dd></div>
                <div><dt>Low point</dt><dd>{formatFeet(route.minimumElevationMeters)}</dd></div>
                <div><dt>High point</dt><dd className={warningClass(violated.has("maximum-elevation"))}>{formatFeet(route.maximumElevationMeters)}</dd></div>
                <div><dt>Repeated trail</dt><dd className={warningClass(violated.has("repeated-trail"))}>{Math.round(route.topology.repeatedTrailFraction * 100)}%</dd></div>
                {route.topology.sharedStemDistanceMeters > 0 ? <div><dt>Shared stem</dt><dd className={warningClass(violated.has("shared-stem"))}>{formatMiles(route.topology.sharedStemDistanceMeters)}</dd></div> : null}
                <div><dt>Cycle blocks</dt><dd>{route.topology.cycleBlockCount.toLocaleString("en-US")}</dd></div>
              </dl>

              <footer className="route-source">
                <span><strong>{route.source.confidence}</strong> confidence</span>
                <span>{route.source.sourceIds.join(", ")}</span>
                <span>{formatFreshness(route.source.freshness)}</span>
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
  results,
  message,
  selectedRouteId,
  onSelectRoute,
  onHoverRoute,
  mobileVisible = true,
  desktopVisible = true,
  hoveredRouteId,
  selectedSegmentId,
  hoveredSegmentId,
  onSelectSegment,
  onHoverSegment,
  nearMissesOpen = false,
  onToggleNearMisses,
  pagination,
  onClose,
}: ResultsPanelProps) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const segmentRefs = useRef(new Map<string, HTMLButtonElement>());
  const panelClassName = [
    "results-panel",
    mobileVisible ? "" : "mobile-panel-hidden",
    desktopVisible ? "" : "desktop-panel-hidden",
  ].filter(Boolean).join(" ");
  const routes = useMemo(
    () => results ? [...results.exact, ...results.nearMisses] : [],
    [results],
  );

  useEffect(() => () => onHoverRoute(undefined), [onHoverRoute, results]);

  // Selecting a route or segment on the map snaps its card into view.
  // Selection only — hover must never move the list under the cursor.
  useEffect(() => {
    if (!selectedRouteId) return;
    const index = routes.findIndex((route) => route.id === selectedRouteId);
    if (index < 0) return;
    const button = cardRefs.current[index];
    // Scroll the whole card, not just its summary button, so neither the
    // card's edges nor its expanded detail land outside the viewport.
    const card = button?.closest(".route-card") ?? button;
    if (typeof card?.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest" });
    }
  }, [selectedRouteId, routes]);

  useEffect(() => {
    if (!selectedSegmentId) return;
    const segment = segmentRefs.current.get(selectedSegmentId);
    if (typeof segment?.scrollIntoView === "function") {
      segment.scrollIntoView({ block: "nearest" });
    }
  }, [selectedSegmentId]);

  // Hovering a segment on the map scrolls it into view, but only within the
  // segment list's own scrollbox — the results panel must not move on hover.
  useEffect(() => {
    if (!hoveredSegmentId) return;
    const row = segmentRefs.current.get(hoveredSegmentId);
    const list = row?.closest(".trail-segment-list");
    if (!row || !(list instanceof HTMLElement)) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) list.scrollTop += rowRect.top - listRect.top;
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
  }, [hoveredSegmentId]);

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
        <ResultsHeading onClose={onClose} />
        <p className="results-state loading-state" role="status" aria-live="polite">Searching eligible trailheads and generating routes…</p>
      </aside>
    );
  }

  if (status === "error") {
    return (
      <aside className={panelClassName} aria-labelledby="results-title">
        <ResultsHeading onClose={onClose} />
        <div className="results-state error-state" role="alert"><strong>Routes could not be generated.</strong><span>{message ?? "Try a different area or looser constraints."}</span></div>
      </aside>
    );
  }

  if (status === "cancelled") {
    return (
      <aside className={panelClassName} aria-labelledby="results-title">
        <ResultsHeading onClose={onClose} />
        <div className="results-state cancelled-state" role="status" aria-live="polite"><strong>No routes were changed.</strong><span>Adjust your settings and search again.</span></div>
      </aside>
    );
  }

  if (!results) return null;

  const total = routes.length;
  const quick = results.kind === "quick" ? results : undefined;
  const job = results.kind === "saved" ? results.job : undefined;

  return (
    <aside className={panelClassName} aria-labelledby="results-title">
      <ResultsHeading total={total} onClose={onClose} />
      <p className="viewed-search-context">Viewing {quick?.area.label ?? job?.area.label} · {(quick?.request.criteria ?? job!.request.criteria).distanceMiles.min}–{(quick?.request.criteria ?? job!.request.criteria).distanceMiles.max} mi</p>

      {quick && results.exact.length < quick.request.limit ? (
        <div className="results-state" role="status" aria-live="polite">
          <strong>{results.exact.length} of {quick.request.limit} requested exact routes found.</strong>
          <span>{quick.incomplete
            ? "This search is incomplete."
            : "Fewer exact matches than requested."} Close matches are listed separately.</span>
        </div>
      ) : null}

      {quick?.incomplete && quick.exact.length >= quick.request.limit ? <p className="results-state" role="status">This search is incomplete. Some areas or starts could not be fully searched.</p> : null}
      {quick?.messages.length ? <div className="results-state" role="status">{quick.messages.map((message, index) => <p key={index}>{message}</p>)}</div> : null}
      {job ? (
        <div className="results-state" role="status">
          <strong>Full search {job.status.replaceAll("-", " ")}.</strong>
          <span>{job.progress.processedAccessPointCount} of {job.progress.eligibleAccessPointCount} trailheads attempted.</span>
          {job.partial ? <span> Partial results retained.</span> : null}
          {job.stale ? <span> Built with an older pack version.</span> : null}
          {job.progress.truncatedAccessPointCount > 0 ? <span> {job.progress.truncatedAccessPointCount} trailhead {job.progress.truncatedAccessPointCount === 1 ? "search reached its search limit" : "searches reached their search limits"}.</span> : null}
          {job.error ? <span> {job.error}</span> : null}
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
              <span>{results.exact.length}</span>
            </div>
            {results.exact.map((route, index) => (
              <RouteCard
                key={route.id}
                route={route}
                routeNumber={index + 1}
                selected={route.id === selectedRouteId}
                hovered={route.id === hoveredRouteId}
                buttonRef={(node) => { cardRefs.current[index] = node; }}
                segmentButtonRef={(segmentId, node) => {
                  if (node) segmentRefs.current.set(segmentId, node);
                  else segmentRefs.current.delete(segmentId);
                }}
                onSelect={() => onSelectRoute(route.id)}
                onHover={onHoverRoute}
                selectedSegmentId={selectedSegmentId}
                hoveredSegmentId={hoveredSegmentId}
                onSelectSegment={onSelectSegment}
                onHoverSegment={onHoverSegment}
                regionLabel={route.regionLabel}
              />
            ))}
          </section>

          {results.nearMisses.length > 0 ? (
            /* Close matches stay folded away while there are exact matches to
               read; with none, they are the only thing left to look at. */
            <details className="result-section near-misses" open={nearMissesOpen} aria-labelledby="near-results-title" onToggle={(event) => { if (!event.currentTarget.open) onHoverRoute(undefined); onToggleNearMisses?.(event.currentTarget.open); }}>
              <summary className="result-section-heading"><h3 id="near-results-title">Close matches</h3><span>{results.nearMisses.length}</span></summary>
              {results.nearMisses.map((route, index) => (
                <RouteCard
                  key={route.id}
                  route={route}
                  routeNumber={results.exact.length + index + 1}
                  selected={route.id === selectedRouteId}
                  hovered={route.id === hoveredRouteId}
                  buttonRef={(node) => { cardRefs.current[results.exact.length + index] = node; }}
                  segmentButtonRef={(segmentId, node) => {
                    if (node) segmentRefs.current.set(segmentId, node);
                    else segmentRefs.current.delete(segmentId);
                  }}
                  onSelect={() => onSelectRoute(route.id)}
                  onHover={onHoverRoute}
                  selectedSegmentId={selectedSegmentId}
                  hoveredSegmentId={hoveredSegmentId}
                  onSelectSegment={onSelectSegment}
                  onHoverSegment={onHoverSegment}
                  regionLabel={route.regionLabel}
                />
              ))}
            </details>
          ) : null}
        </div>
      )}

      {pagination ? (
        <nav className="results-pagination" aria-label="Batch result pages">
          <button type="button" className="btn" disabled={!pagination.hasNext || pagination.loading} onClick={pagination.onNext}>
            {pagination.loading ? "Loading…" : pagination.hasNext ? "Next 50 routes" : "Last page"}
          </button>
        </nav>
      ) : null}

      <details className="diagnostics">
        <summary>Diagnostics</summary>
        {quick ? <>
          <p>{quick.area.label}</p>
        </> : null}
        {job ? <>
          <p>{job.area.label}</p>
          <dl>
            <div><dt>Elapsed</dt><dd>{Math.round(job.progress.elapsedMs).toLocaleString("en-US")} ms</dd></div>
            <div><dt>Saved exact routes</dt><dd>{job.progress.exactRouteCount}</dd></div>
            <div><dt>Saved close matches</dt><dd>{job.progress.nearMissRouteCount}</dd></div>
            <div><dt>Job ID</dt><dd>{job.id}</dd></div>
          </dl>
        </> : null}
      </details>
    </aside>
  );
}
