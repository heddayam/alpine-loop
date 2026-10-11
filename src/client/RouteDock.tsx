import { useMemo, useState } from "react";
import { routeName } from "../route-name.js";
import type {
  JobSnapshot,
  RouteLocation,
} from "../model.js";
import { StarIcon } from "./StarIcon.js";
import { FixedList } from "./FixedList.js";
import {
  distanceText,
  elevationText,
  stemDistance,
  unitsFor,
  type UnitSystem,
} from "./units.js";

/** The comparison list remains available while a hike is inspected on the map. */
export function RouteDock({
  job,
  regionNames,
  units,
  hidden,
  routes,
  starredRoutes,
  starsCollapsed,
  onToggleStars,
  onToggleStar,
  total,
  scope,
  selectedId,
  previewId,
  loadingMap,
  onScope,
  onSelect,
  onPreview,
  onClear,
}: {
  job: JobSnapshot;
  regionNames: string[];
  units: UnitSystem;
  hidden: boolean;
  routes: RouteLocation[];
  starredRoutes: RouteLocation[];
  starsCollapsed: boolean;
  onToggleStars: () => void;
  onToggleStar: (id: string) => void;
  total: number;
  scope: "view" | "all" | ReadonlySet<string>;
  selectedId: string | null;
  previewId: string | null;
  loadingMap: boolean;
  onScope: (scope: "view" | "all") => void;
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  onClear: () => void;
}) {
  const [sort, setSort] = useState<"distance" | "gain" | "stem" | "roadDistance">(
    "distance",
  );
  const [descending, setDescending] = useState(false);
  const display = unitsFor(units);
  const { sorted, starred } = useMemo(() => {
    const compare = (a: RouteLocation, b: RouteLocation) => {
      const delta = sort === "stem" ? stemDistance(a) - stemDistance(b) : a[sort] - b[sort];
      return delta * (descending ? -1 : 1) || a.id.localeCompare(b.id);
    };
    const pins = new Set(starredRoutes.map(route => route.id));
    return {
      sorted: routes.filter(route => !pins.has(route.id)).sort(compare),
      starred: [...starredRoutes].sort(compare),
    };
  }, [routes, starredRoutes, sort, descending]);
  const row = (route: RouteLocation, index: number, size: number, pinned = false) => (
    <li key={route.id} className={pinned ? "has-star" : undefined} aria-posinset={index + 1} aria-setsize={size}>
      <button
        className="hike-select"
        id={`hike-${route.id}`}
        type="button"
        data-row={index}
        aria-pressed={selectedId === route.id}
        data-preview={previewId === route.id ? "true" : undefined}
        title={routeName(route)}
        onPointerEnter={() => onPreview(route.id)}
        onPointerLeave={() => onPreview(null)}
        onFocus={() => onPreview(route.id)}
        onBlur={() => onPreview(null)}
        onClick={() => selectedId === route.id ? onClear() : onSelect(route.id)}
      >
        <strong>{routeName(route)}</strong>
        <span className="row-metrics">
          <span>{distanceText(route.distance, units)} <small>{display.distanceLabel}</small></span>
          <span title="Elevation gain">{elevationText(route.gain, units)} <small>{display.elevationLabel}</small></span>
          <span title="One-way approach walked again on the return">
            {distanceText(stemDistance(route), units)} <small>{display.distanceLabel} approach</small>
          </span>
        </span>
      </button>
      {pinned && <button type="button" className="star-route row-star" aria-pressed="true"
        aria-label={`Unstar ${routeName(route)}`}
        onClick={() => {
          onToggleStar(route.id);
          requestAnimationFrame(() => (
            document.getElementById(`hike-${route.id}`)
              ?? document.querySelector<HTMLButtonElement>(".starred-toggle")
              ?? document.getElementById("results-heading")
          )?.focus({ preventScroll: true }));
        }}>
        <StarIcon filled />
      </button>}
    </li>
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
                {regionNames.length} regions
                <span id="results-areas" className="results-areas" role="tooltip">
                  {regionNames.map(name => <span key={name}>{name}</span>)}
                </span>
              </span>
            </> : regionNames[0]}
          </h2>
          <span className="result-count" role="status">
            {typeof scope !== "string"
              ? `${routes.length.toLocaleString()} at marker`
              : scope === "view" && routes.length !== total
                ? `${routes.length.toLocaleString()} of ${total.toLocaleString()} routes`
                : `${total.toLocaleString()} routes`}
          </span>
        </div>
        <p className="saved-request">
          {distanceText(job.query.distance[0], units)}–{distanceText(job.query.distance[1], units)} {display.distanceLabel}, {elevationText(job.query.gain[0], units)}–{elevationText(job.query.gain[1], units)} {display.elevationLabel} gain
        </p>
      </header>
      <div className="results-toolbar">
        <div className="view-toggle" role="group" aria-label="Result scope">
          <span className="results-show">Show:</span>
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
        <div className="results-sort">
          <select
            id="result-sort"
            aria-label="Sort hikes"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="distance">Distance</option>
            <option value="gain">Elev. Gain</option>
            <option value="stem">Approach</option>
            <option value="roadDistance">Road</option>
          </select>
          <button
            type="button"
            className="sort-direction"
            aria-label={`Sort ${descending ? "highest" : "lowest"} first; reverse order`}
            title={`${descending ? "Highest" : "Lowest"} first; reverse order`}
            onClick={() => setDescending((current) => !current)}
          >
            {descending ? "↓" : "↑"}
          </button>
        </div>
      </div>
      <div className="results-list">
        {!!starred.length && (
          <section className="starred-section" aria-label="Starred routes">
            <button type="button" className="starred-toggle" aria-expanded={!starsCollapsed}
              aria-controls="starred-routes" onClick={onToggleStars}>
              <span aria-hidden="true">{starsCollapsed ? "▸" : "▾"}</span>
              Starred <span className="starred-count">{starred.length}</span>
            </button>
            <div id="starred-routes" className="starred-list" hidden={starsCollapsed}>
              <FixedList items={starred} rowHeight={52}>
                {(route, index) => row(route, index, starred.length, true)}
              </FixedList>
            </div>
          </section>
        )}
        <FixedList items={sorted} rowHeight={52}>
          {(route, index) => row(route, index, sorted.length)}
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
    </aside>
  );
}
