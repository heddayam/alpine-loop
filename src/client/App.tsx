import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Bounds,
  DatasetInfo,
  HikeRoute,
  SearchQuery,
  SearchSnapshot,
} from "../model.js";
import { HikeMap } from "./Map.js";

const MILE = 1609.344;
const FOOT = 0.3048;
const CURRENT_SEARCH = "alpine-loop.current-search";
const miles = (meters: number) => (meters / MILE).toFixed(1);
const feet = (meters: number) => Math.round(meters / FOOT).toLocaleString();
const routeName = (route: HikeRoute) =>
  route.trailNames.slice(0, 2).join(" / ") || route.startName || "Unnamed trails";
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(CURRENT_SEARCH, id);
    else localStorage.removeItem(CURRENT_SEARCH);
  } catch {
    /* Search still works without storage. */
  }
};
async function request<T>(
  url: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 404
          ? "This search has expired. The server may have restarted. Start a new search."
          : typeof data?.error === "string"
            ? data.error
            : (data?.message ??
              data?.error?.message ??
              "The server could not complete this request."),
      ),
      { status: response.status },
    );
  return data as T;
}
const routeBounds = (route: HikeRoute): Bounds => {
  const xs = route.geometry.map((point) => point[0]);
  const ys = route.geometry.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

function Range({
  name,
  unit,
  value,
  onChange,
}: {
  name: string;
  unit: string;
  value: [string, string];
  onChange: (next: [string, string]) => void;
}) {
  const key = name.toLowerCase().replaceAll(" ", "-");
  return (
    <fieldset className="range-field">
      <legend>
        {name} <span>{unit}</span>
      </legend>
      <div className="range-pair">
        <label htmlFor={`${key}-min`}>
          <span>Min</span>
          <input
            id={`${key}-min`}
            aria-label={`Minimum ${name.toLowerCase()} (${unit})`}
            type="number"
            min="0"
            step="any"
            required
            value={value[0]}
            onChange={(event) => onChange([event.target.value, value[1]])}
          />
        </label>
        <span className="range-dash" aria-hidden="true">
          –
        </span>
        <label htmlFor={`${key}-max`}>
          <span>Max</span>
          <input
            id={`${key}-max`}
            aria-label={`Maximum ${name.toLowerCase()} (${unit})`}
            type="number"
            min="0"
            step="any"
            required
            value={value[1]}
            onChange={(event) => onChange([value[0], event.target.value])}
          />
        </label>
      </div>
    </fieldset>
  );
}

function RouteDetails({
  route,
  searchId,
  onBack,
}: {
  route: HikeRoute;
  searchId: string;
  onBack: () => void;
}) {
  return (
    <section className="route-detail" aria-label="Route details">
      <button type="button" className="text-button" onClick={onBack}>
        ← All routes
      </button>
      <h2 id="route-detail-heading" tabIndex={-1}>
        {routeName(route)}
      </h2>
      <p className="quiet">From {route.startName || "an unnamed starting point"}</p>
      <p className="route-kind">
        {route.kind === "lollipop"
          ? "Lollipop · an out-and-back approach to a loop"
          : "Loop · returns without retracing trail"}
      </p>
      <dl className="detail-metrics">
        <div>
          <dt>Distance</dt>
          <dd>
            {miles(route.distance)} <small>mi</small>
          </dd>
        </div>
        <div>
          <dt>Climb</dt>
          <dd>
            {feet(route.gain)} <small>ft</small>
          </dd>
        </div>
        <div>
          <dt>Walked again</dt>
          <dd>
            {Math.round(route.repetition * 100)}
            <small>%</small>
          </dd>
        </div>
      </dl>
      {route.uncertain && (
        <p className="access-note">
          Some access is uncertain. Check before heading out.
        </p>
      )}
      <a
        className="primary button export-button"
        href={`/api/search/${encodeURIComponent(searchId)}/routes/${encodeURIComponent(route.id)}.gpx`}
        download
      >
        Download GPX
      </a>
      {!!route.trailNames.length && (
        <div className="trail-names">
          <h3>Trails</h3>
          <p>{[...new Set(route.trailNames)].join(" · ")}</p>
        </div>
      )}
      <p className="quiet">
        Start: {route.geometry[0]?.[1].toFixed(5)},{" "}
        {route.geometry[0]?.[0].toFixed(5)}
      </p>
    </section>
  );
}

function progressLabel(search: SearchSnapshot) {
  if (search.status === "running") return "Searching";
  if (search.status === "complete") return "Search complete";
  if (search.status === "stopped") return "Stopped early";
  if (search.status === "limited") return "Exploration unfinished";
  return "Search interrupted";
}

export function App() {
  const [dataset, setDataset] = useState<DatasetInfo>();
  const [startupError, setStartupError] = useState("");
  const [area, setArea] = useState<Bounds | null>(null);
  const [areaMode, setAreaMode] = useState<"view" | "drawn" | "retained">(
    "view",
  );
  const [editing, setEditing] = useState(true);
  const [drawing, setDrawing] = useState(false);
  const [camera, setCamera] = useState<{
    bounds: Bounds;
    revision: number;
    selectArea?: boolean;
  }>();
  const [distance, setDistance] = useState<[string, string]>(["5", "12"]);
  const [gain, setGain] = useState<[string, string]>(["0", "4000"]);
  const [repetition, setRepetition] = useState("20");
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const [search, setSearch] = useState<SearchSnapshot>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const selected = search?.routes.find((route) => route.id === selectedId);
  const running = search?.status === "running";

  useEffect(() => {
    const controller = new AbortController();
    void request<DatasetInfo>("/api/catalog", controller.signal)
      .then(async (info) => {
        setArea(info.bounds);
        setCamera({ bounds: info.bounds, revision: 0, selectArea: true });
        let id: string | null = null;
        try {
          id = localStorage.getItem(CURRENT_SEARCH);
        } catch {
          /* Storage is optional. */
        }
        if (id)
          await request<SearchSnapshot>(
            `/api/search/${encodeURIComponent(id)}`,
            controller.signal,
          )
            .then((snapshot) => {
              setSearch(snapshot);
              restoreDraft(snapshot);
              setEditing(false);
            })
            .catch((failure) => {
              if (!controller.signal.aborted) {
                // Do not let a transient failure replace a still-running search
                // whose identifier is our only way to reconnect or stop it.
                if (failure.status !== 404) throw failure;
                remember(null);
                setError(failure.message);
              }
            });
        if (!controller.signal.aborted) setDataset(info);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setStartupError(failure.message);
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!search || search.status !== "running" || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await request<SearchSnapshot>(
          `/api/search/${encodeURIComponent(search.id)}`,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSearch(snapshot);
          setConnectionError("");
        }
        if (snapshot.status !== "running") return;
      } catch (failure) {
        if (controller.signal.aborted) return;
        setConnectionError(
          failure instanceof Error
            ? failure.message
            : "Connection lost. Reconnecting…",
        );
        if ((failure as { status?: number }).status === 404) {
          setError((failure as Error).message);
          setConnectionError("");
          setSearch(undefined);
          setSelectedId(null);
          setEditing(true);
          remember(null);
          return;
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 750);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [search?.id, search?.status, retry, busy]);

  const launch = async (event: FormEvent) => {
    event.preventDefault();
    if (!area || busy || drawing) return;
    const distances = distance.map(Number),
      gains = gain.map(Number),
      repeated = Number(repetition);
    if (
      [...distances, ...gains, repeated].some(
        (value) => !Number.isFinite(value) || value < 0,
      ) ||
      !distances[1] ||
      distances[0]! > distances[1]! ||
      gains[0]! > gains[1]! ||
      repeated > 100
    ) {
      setError(
        "Use a positive maximum distance and ranges whose minimum is no greater than their maximum. Repetition must be 0–100%.",
      );
      return;
    }
    const query: SearchQuery = {
      area,
      distance: [distances[0]! * MILE, distances[1]! * MILE],
      gain: [gains[0]! * FOOT, gains[1]! * FOOT],
      repetition: repeated / 100,
      includeUnknown,
    };
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setSelectedId(null);
    try {
      if (search?.status === "running") {
        const stopped = await request<SearchSnapshot>(
          `/api/search/${encodeURIComponent(search.id)}/stop`,
          controller.signal,
          {},
        );
        if (!controller.signal.aborted) setSearch(stopped);
      }
      const snapshot = await request<SearchSnapshot>(
        "/api/search",
        controller.signal,
        query,
      );
      if (!controller.signal.aborted) {
        setSearch(snapshot);
        setEditing(false);
        setConnectionError("");
        remember(snapshot.id);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Search could not start.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const stop = async () => {
    if (!search || busy) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      const snapshot = await request<SearchSnapshot>(
        `/api/search/${encodeURIComponent(search.id)}/stop`,
        controller.signal,
        {},
      );
      if (!controller.signal.aborted) {
        setSearch(snapshot);
        setError("");
        setConnectionError("");
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not stop the search. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const moveTo = (bounds: Bounds, selectArea = false) =>
    setCamera((current) => ({
      bounds,
      revision: (current?.revision ?? 0) + 1,
      selectArea,
    }));
  const restoreDraft = (snapshot = search) => {
    if (!snapshot) return;
    setArea(snapshot.query.area);
    setAreaMode("retained");
    setDistance(
      snapshot.query.distance.map((value) => String(value / MILE)) as [
        string,
        string,
      ],
    );
    setGain(
      snapshot.query.gain.map((value) => String(value / FOOT)) as [
        string,
        string,
      ],
    );
    setRepetition(String(snapshot.query.repetition * 100));
    setIncludeUnknown(snapshot.query.includeUnknown);
    setSelectedId(null);
    moveTo(snapshot.query.area);
  };
  const pickRoute = (id: string) => {
    const route = search?.routes.find((route) => route.id === id);
    if (!route || editing) return;
    setSelectedId(id);
    moveTo(routeBounds(route));
    requestAnimationFrame(() =>
      document.getElementById("route-detail-heading")?.focus(),
    );
  };
  const backToRoutes = () => {
    const id = selectedId;
    setSelectedId(null);
    if (search) moveTo(search.query.area);
    requestAnimationFrame(() =>
      document.getElementById(`route-${id}`)?.focus(),
    );
  };
  const currentRoutes = search?.routes ?? [];
  const selectionNote = (
    search as (SearchSnapshot & { selectionNote?: string }) | undefined
  )?.selectionNote;
  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="Route planner">
        <header className="app-label">
          <h1>Alpine Loop</h1>
          <span title={dataset?.name}>{dataset?.name ?? "Washington"}</span>
        </header>
        {!dataset ? (
          <div className="startup" role={startupError ? "alert" : "status"}>
            <p>{startupError || "Opening trail data…"}</p>
            {startupError && (
              <button type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="sidebar-content">
              {(error || connectionError) && (
                <div className="error-banner" role="alert">
                  <p>{error || connectionError}</p>
                  {connectionError && !error && running && (
                    <button
                      type="button"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              )}
              {editing ? (
                <form
                  className="planner"
                  onSubmit={(event) => void launch(event)}
                >
                  <div className="section-heading">
                    <h2>Where</h2>
                    {search && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          restoreDraft();
                          setError("");
                          setEditing(false);
                        }}
                      >
                        Cancel edit
                      </button>
                    )}
                  </div>
                  <label className="visually-hidden" htmlFor="place">
                    Go to a region
                  </label>
                  <select
                    id="place"
                    value=""
                    onChange={(event) => {
                      const place = dataset.places[Number(event.target.value)];
                      if (place) {
                        setAreaMode("view");
                        moveTo(place.bounds, true);
                      }
                    }}
                  >
                    <option value="" disabled>
                      Go to a region…
                    </option>
                    {dataset.places.map((place, index) => (
                      <option key={place.name} value={index}>
                        {place.name}
                      </option>
                    ))}
                  </select>
                  <p className="area-description">
                    {areaMode === "drawn"
                      ? "Starts inside your rectangle."
                      : areaMode === "retained"
                        ? "Previous search area. Pan the map to change it."
                        : "Starts in the visible map area. Pan or zoom to choose."}
                  </p>
                  <h2 className="limits-heading">Limits</h2>
                  <Range
                    name="Distance"
                    unit="miles"
                    value={distance}
                    onChange={setDistance}
                  />
                  <Range
                    name="Elevation gain"
                    unit="feet"
                    value={gain}
                    onChange={setGain}
                  />
                  <label className="repetition-field" htmlFor="repetition">
                    <span>Maximum walked again</span>
                    <span className="percent-input">
                      <input
                        id="repetition"
                        type="number"
                        min="0"
                        max="100"
                        step="any"
                        required
                        value={repetition}
                        onChange={(event) => setRepetition(event.target.value)}
                      />
                      <span>%</span>
                    </span>
                  </label>
                  <p className="field-hint">
                    20% = 2 miles walked again in a 10-mile hike.
                  </p>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={includeUnknown}
                      onChange={(event) =>
                        setIncludeUnknown(event.target.checked)
                      }
                    />{" "}
                    Include uncertain access
                  </label>
                  <button
                    className="primary search-button"
                    type="submit"
                    disabled={busy || !area || drawing}
                  >
                    {busy
                      ? "Please wait…"
                      : running
                        ? "Replace current search"
                        : "Search this area"}
                  </button>
                  {drawing ? (
                    <p className="field-hint">
                      Finish drawing or cancel it to search.
                    </p>
                  ) : running ? (
                    <p className="field-hint">
                      Replaces the running search and its results.
                    </p>
                  ) : null}
                </form>
              ) : (
                search && (
                  <>
                    <section
                      className="search-summary"
                      aria-label="Current search"
                    >
                      <div className="section-heading">
                        <h2>Current search</h2>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => {
                            restoreDraft();
                            setEditing(true);
                          }}
                        >
                          Edit search
                        </button>
                      </div>
                      <p className="query-summary">
                        {miles(search.query.distance[0])}–
                        {miles(search.query.distance[1])} mi ·{" "}
                        {feet(search.query.gain[0])}–
                        {feet(search.query.gain[1])} ft climb
                        <br />
                        At most {Math.round(search.query.repetition * 100)}%
                        walked again
                      </p>
                      <p className="access-summary">
                        {search.query.includeUnknown
                          ? "Uncertain access included"
                          : "Mapped public access only"}
                      </p>
                    </section>
                    <section
                      id="results"
                      className="results"
                      aria-label="Search results"
                    >
                      <div className="section-heading results-heading">
                        <h2>
                          {currentRoutes.length} matching{" "}
                          {currentRoutes.length === 1 ? "route" : "routes"}
                        </h2>
                        {running && (
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => void stop()}
                            disabled={busy}
                          >
                            Stop search
                          </button>
                        )}
                      </div>
                      <div className="search-progress" role="status">
                        <span className={running ? "status-running" : ""}>
                          {progressLabel(search)}
                        </span>
                        <p>
                          {search.progress.attemptedStarts} of{" "}
                          {search.progress.totalStarts} starts tried;{" "}
                          {search.progress.completedStarts} fully explored.
                        </p>
                      </div>
                      {search.status !== "running" &&
                        search.status !== "complete" && (
                          <p className="search-notice">
                            {search.reason ||
                              "More matching routes may exist. Routes found so far are kept."}
                          </p>
                        )}
                      {selectionNote && (
                        <details className="selection-note">
                          <summary>Similar routes grouped</summary>
                          <p>{selectionNote}</p>
                        </details>
                      )}
                      {selected ? (
                        <RouteDetails
                          route={selected}
                          searchId={search.id}
                          onBack={backToRoutes}
                        />
                      ) : currentRoutes.length ? (
                        <ol className="route-list">
                          {currentRoutes.map((route) => (
                            <li key={route.id}>
                              <button
                                id={`route-${route.id}`}
                                className="route-card"
                                type="button"
                                onClick={() => pickRoute(route.id)}
                                onPointerEnter={() => setHoveredId(route.id)}
                                onPointerLeave={() => setHoveredId(null)}
                                onFocus={() => setHoveredId(route.id)}
                                onBlur={() => setHoveredId(null)}
                              >
                                <span className="route-card-top">
                                  <span className="route-name">
                                    {routeName(route)}
                                  </span>
                                </span>
                                <span className="route-metrics">
                                  <strong>
                                    {miles(route.distance)} <small>mi</small>
                                  </strong>
                                  <strong>
                                    ↑ {feet(route.gain)} <small>ft</small>
                                  </strong>
                                  <span>
                                    {Math.round(route.repetition * 100)}% again
                                  </span>
                                </span>
                                <span className="route-kind">
                                  {route.kind === "lollipop"
                                    ? "Lollipop"
                                    : "Loop"}
                                  {route.uncertain ? " · Access uncertain" : ""}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="empty-state">
                          {running
                            ? "Exploring trails. Matching routes appear here as they are found."
                            : search.status === "complete"
                              ? "No routes meet these limits. Edit the search to change your area or limits."
                              : "No matching routes found before exploration ended."}
                        </p>
                      )}
                    </section>
                  </>
                )
              )}
            </div>
            <footer className="data-notes">
              <details>
                <summary>Trail data & limitations</summary>
                <p>
                  {dataset.name} · {dataset.sourceDate}
                </p>
                <ul>
                  {dataset.limitations.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
                {dataset.attribution.map((source) => (
                  <p key={source.url}>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.name}
                    </a>
                    <span className="license">{source.license}</span>
                  </p>
                ))}
              </details>
            </footer>
          </>
        )}
      </aside>
      {dataset && camera ? (
        <HikeMap
          dataset={dataset}
          area={
            editing
              ? areaMode === "view"
                ? null
                : area
              : (search?.query.area ?? area)
          }
          editing={editing}
          drawn={areaMode === "drawn"}
          routes={editing ? [] : currentRoutes}
          selectedId={selectedId ?? hoveredId}
          camera={camera}
          onArea={(bounds) => {
            setArea(bounds);
            setAreaMode("drawn");
          }}
          onViewport={(bounds) => {
            setArea(bounds);
            setAreaMode("view");
          }}
          onDrawing={setDrawing}
          onSelect={pickRoute}
        />
      ) : (
        <div className="map-placeholder" />
      )}
    </main>
  );
}
