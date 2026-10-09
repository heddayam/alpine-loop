import { useMemo, useState } from "react";
import { routeName } from "../route-name.js";
import type {
  JobSnapshot,
  Position,
  RouteLocation,
  RouteView,
} from "../model.js";
import { ElevationProfile } from "./ElevationProfile.js";
import { FixedList } from "./FixedList.js";
import { requestSummary, savedResultsURL } from "./JobsDialog.js";
import {
  distanceText,
  elevationText,
  stemDistance,
  unitsFor,
  type UnitSystem,
} from "./units.js";

const startName = (route: RouteView) => {
  const position = `${route.startPosition[1].toFixed(5)}, ${route.startPosition[0].toFixed(5)}`;
  return !route.startName
    ? position
    : /^(Trail entrance|Mapped parking access)$/.test(route.startName)
      ? `${route.startName} (${position})`
      : route.startName;
};

function RouteDetails({
  route,
  job,
  units,
  onProfileHover,
}: {
  route: RouteView;
  job: JobSnapshot;
  units: UnitSystem;
  onProfileHover: (position: Position | null) => void;
}) {
  const display = unitsFor(units);
  return (
    <section className="route-detail" aria-label="Route details">
      <h2 id="route-detail-heading" tabIndex={-1}>
        {routeName(route)}
      </h2>
      <dl className="detail-metrics">
        <div>
          <dt>Distance</dt>
          <dd>
            {distanceText(route.distance, units)} <small>{display.distanceLabel}</small>
          </dd>
        </div>
        <div>
          <dt>Elev. Gain</dt>
          <dd>
            {elevationText(route.gain, units)} <small>{display.elevationLabel}</small>
          </dd>
        </div>
        <div>
          <dt title="One-way approach walked again on the return">Approach</dt>
          <dd>
            {distanceText(stemDistance(route), units)} <small>{display.distanceLabel}</small>
          </dd>
        </div>
      </dl>
      <div className="route-secondary">
        <p className="road-detail">
          Roads: {distanceText(route.roadDistance, units, 2)} {display.distanceLabel} (
          {((100 * route.roadDistance) / route.distance).toFixed(1)}%)
        </p>
        <a
          className="gpx-download"
          href={savedResultsURL(
            job,
            `routes/${encodeURIComponent(route.id)}.gpx`,
            `units=${units}`,
          )}
          download
        >
          Download GPX
        </a>
      </div>
      <ElevationProfile key={route.id} route={route} units={units} onHover={onProfileHover} />
      <div className="starting-point">
        <h3>Start</h3>
        <p>{startName(route)}</p>
      </div>
      {!!route.trailNames.length && (
        <details className="trail-names">
          <summary>Trails ({new Set(route.trailNames).size})</summary>
          <p>{[...new Set(route.trailNames)].join(", ")}</p>
        </details>
      )}
    </section>
  );
}

/** The comparison list and selected walk share one dock and independent scroll areas. */
export function RouteDock({
  job,
  regionNames,
  units,
  hidden,
  routes,
  total,
  scope,
  selectedId,
  selected,
  loadingMap,
  routeError,
  onScope,
  onSelect,
  onPreview,
  onClear,
  onRetry,
  onProfileHover,
}: {
  job: JobSnapshot;
  regionNames: string[];
  units: UnitSystem;
  hidden: boolean;
  routes: RouteLocation[];
  total: number;
  scope: "view" | "all" | ReadonlySet<string>;
  selectedId: string | null;
  selected: RouteView | null;
  loadingMap: boolean;
  routeError: string;
  onScope: (scope: "view" | "all") => void;
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  onClear: () => void;
  onRetry: () => void;
  onProfileHover: (position: Position | null) => void;
}) {
  const [sort, setSort] = useState<"distance" | "gain" | "stem" | "roadDistance">(
    "distance",
  );
  const [descending, setDescending] = useState(false);
  const display = unitsFor(units);
  const sorted = useMemo(
    () =>
      [...routes].sort((a, b) => {
        const delta =
          sort === "stem" ? stemDistance(a) - stemDistance(b) : a[sort] - b[sort];
        return delta * (descending ? -1 : 1) || a.id.localeCompare(b.id);
      }),
    [routes, sort, descending],
  );
  return (
    <aside
      id="results-panel"
      className="results-panel"
      aria-label="Hike results"
      hidden={hidden}
    >
      <header className="results-header">
        <div>
          <h2 id="results-heading" tabIndex={-1}>
            {regionNames.length > 1 ? <>
              Results in <span className="results-areas-trigger" tabIndex={0} aria-describedby="results-areas">
                {regionNames.length} regions <span aria-hidden="true">▾</span>
                <span id="results-areas" className="results-areas" role="tooltip">
                  {regionNames.map(name => <span key={name}>{name}</span>)}
                </span>
              </span>
            </> : regionNames[0]}
          </h2>
          <span className="result-count">{total.toLocaleString()} routes</span>
        </div>
        <p className="saved-request">{requestSummary(job.query, units)}</p>
      </header>
      <div className="results-filter">
        <div className="view-toggle" role="group" aria-label="Result scope">
          <button
            type="button"
            aria-pressed={scope === "view"}
            title="Hikes with a starting point in the map view"
            onClick={() => onScope("view")}
          >
            In view
          </button>
          <button
            type="button"
            aria-pressed={scope === "all"}
            title="All hikes in this search"
            onClick={() => onScope("all")}
          >
            All
          </button>
        </div>
        <span role="status">
          {routes.length.toLocaleString()}
          {scope === "view" ? ` / ${total.toLocaleString()}` : ""}
          {typeof scope !== "string" ? " at marker" : " shown"}
        </span>
      </div>
      <div className="results-sort">
        <label htmlFor="result-sort">Sort</label>
        <select
          id="result-sort"
          aria-label="Sort hikes"
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="distance">Distance</option>
          <option value="gain">Elev. Gain</option>
          <option value="stem">Approach distance</option>
          <option value="roadDistance">Road distance</option>
        </select>
        <button
          type="button"
          className="sort-direction"
          aria-label={`Sort ${descending ? "highest" : "lowest"} first; reverse order`}
          onClick={() => setDescending((current) => !current)}
        >
          {descending ? "Desc" : "Asc"}
        </button>
      </div>
      <div className="results-list">
        <FixedList items={sorted} rowHeight={52}>
          {(route, index) => (
            <li
              key={route.id}
              aria-posinset={index + 1}
              aria-setsize={sorted.length}
            >
              <button
                id={`hike-${route.id}`}
                type="button"
                data-row={index}
                aria-pressed={selectedId === route.id}
                title={routeName(route)}
                onPointerEnter={() => onPreview(route.id)}
                onPointerLeave={() => onPreview(null)}
                onFocus={() => onPreview(route.id)}
                onBlur={() => onPreview(null)}
                onClick={() =>
                  selectedId === route.id ? onClear() : onSelect(route.id)
                }
              >
                <strong>{routeName(route)}</strong>
                <span className="row-metrics">
                  <span>
                    {distanceText(route.distance, units)} <small>{display.distanceLabel}</small>
                  </span>
                  <span title="Elevation gain">
                    {elevationText(route.gain, units)} <small>{display.elevationLabel}</small>
                  </span>
                  <span title="One-way approach walked again on the return">
                    {distanceText(stemDistance(route), units)} <small>{display.distanceLabel} approach</small>
                  </span>
                </span>
              </button>
            </li>
          )}
        </FixedList>
        {!routes.length && (
          <p className="empty-state">
            {!total
              ? "No qualifying hikes found by this search."
              : loadingMap && scope === "view"
                ? "Loading map…"
                : "No hike starts in view. Choose All or move the map."}
          </p>
        )}
      </div>
      {selectedId && (
        <div className="route-inspector" aria-label="Selected hike">
          <button
            className="back-to-results"
            type="button"
            onClick={onClear}
          >
            <span aria-hidden="true">←</span> Back to results
          </button>
          {selected ? (
            <RouteDetails
              route={selected}
              job={job}
              units={units}
              onProfileHover={onProfileHover}
            />
          ) : (
            <div className="route-loading">
              <p role={routeError ? "alert" : "status"}>
                {routeError || "Loading hike details…"}
              </p>
              {routeError && (
                <button type="button" onClick={onRetry}>
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
