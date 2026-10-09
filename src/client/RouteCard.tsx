import { useEffect, useRef, type Ref } from "react";
import { routeName } from "../route-name.js";
import type { JobSnapshot, Position, RouteView } from "../model.js";
import { ElevationProfile } from "./ElevationProfile.js";
import { savedResultsURL } from "./JobsDialog.js";
import { distanceText, elevationText, stemDistance, unitsFor, type UnitSystem } from "./units.js";

const startName = (route: RouteView) => {
  const name = route.startName?.trim();
  return !name || /^(Trail entrance|Mapped parking access|Trail start|Trailhead)$/i.test(name)
    ? "Unnamed trailhead"
    : name;
};

export function RouteCard({
  ref, route, job, units, error, onClose, onRetry, onProfileHover,
}: {
  ref?: Ref<HTMLElement>;
  route: RouteView | null;
  job: JobSnapshot;
  units: UnitSystem;
  error: string;
  onClose: () => void;
  onRetry: () => void;
  onProfileHover: (position: Position | null) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const display = unitsFor(units);
  const name = route ? routeName(route) : "Hike details";
  const trailhead = route ? startName(route) : "";
  const trails = route ? [...new Set(route.trailNames)] : [];
  return (
    <aside
      ref={ref}
      className="map-route-card"
      aria-label="Selected hike"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="route-card-header">
        <h2 ref={heading} id="route-detail-heading" tabIndex={-1} title={name}>
          {name}
        </h2>
        {route && <span className="route-card-trailhead" title={trailhead}>
          {trailhead}
        </span>}
        <button className="close-route-card" type="button" aria-label="Close hike details" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 4 12 12M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {route ? (
        <div className="route-detail">
          <dl className="detail-metrics">
            <div>
              <dt>Distance</dt>
              <dd>{distanceText(route.distance, units)} <small>{display.distanceLabel}</small></dd>
            </div>
            <div>
              <dt>Elev. Gain</dt>
              <dd>{elevationText(route.gain, units)} <small>{display.elevationLabel}</small></dd>
            </div>
            <div>
              <dt title="One-way approach walked again on the return">Approach</dt>
              <dd>{distanceText(stemDistance(route), units)} <small>{display.distanceLabel}</small></dd>
            </div>
          </dl>
          <div className="route-secondary">
            <p className="road-detail">
              Roads: {distanceText(route.roadDistance, units, 2)} {display.distanceLabel} ({((100 * route.roadDistance) / route.distance).toFixed(1)}%)
            </p>
            <a
              className="gpx-download"
              href={savedResultsURL(job, `routes/${encodeURIComponent(route.id)}.gpx`, `units=${units}`)}
              download
            >
              Download GPX
            </a>
          </div>
          <ElevationProfile key={route.id} route={route} units={units} onHover={onProfileHover} />
          {!!trails.length && (
            <details className="trail-names">
              <summary>Trails ({trails.length})</summary>
              <p>{trails.join(", ")}</p>
            </details>
          )}
        </div>
      ) : (
        <div className="route-loading">
          <p role={error ? "alert" : "status"}>{error || "Loading hike details…"}</p>
          {error && <button type="button" onClick={() => {
            heading.current?.focus({ preventScroll: true });
            onRetry();
          }}>Retry</button>}
        </div>
      )}
    </aside>
  );
}
