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

function Elevation({ route }: { route: HikeRoute }) {
  const elevations = route.geometry.map((point) => point[2]);
  if (elevations.some((value) => value === undefined) || elevations.length < 2)
    return null;
  const values = elevations as number[];
  const min = Math.min(...values),
    max = Math.max(...values);
  const lengths = [0];
  for (let index = 1; index < route.geometry.length; index++) {
    const a = route.geometry[index - 1]!,
      b = route.geometry[index]!;
    const radians = Math.PI / 180;
    const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * radians);
    lengths.push(lengths[index - 1]! + Math.hypot(x, b[1] - a[1]));
  }
  const total = lengths.at(-1)! || 1;
  const points = values
    .map(
      (value, index) =>
        `${8 + (lengths[index]! / total) * 284},${70 - ((value - min) / (max - min || 1)) * 56}`,
    )
    .join(" ");
  return (
    <figure className="elevation">
      <svg
        viewBox="0 0 300 80"
        role="img"
        aria-label={`Elevation profile: ${feet(min)} to ${feet(max)} feet`}
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
      <figcaption>
        <span>
          {feet(min)}–{feet(max)} ft elevation
        </span>
        <span>{miles(route.distance)} mi</span>
      </figcaption>
    </figure>
  );
}

function RouteDetails({
  route,
  searchId,
  onBack,
  onFit,
}: {
  route: HikeRoute;
  searchId: string;
  onBack: () => void;
  onFit: () => void;
}) {
  return (
    <section className="route-detail" aria-label="Route details">
      <button type="button" className="text-button" onClick={onBack}>
        ← All routes
      </button>
      <div className="section-kicker">
        {route.kind === "lollipop" ? "Lollipop · shared approach" : "Loop"}
      </div>
      <h2>{route.startName || "Unnamed starting point"}</h2>
      <div className="detail-metrics">
        <span>
          <strong>{miles(route.distance)}</strong> miles
        </span>
        <span>
          <strong>{feet(route.gain)}</strong> ft climb
        </span>
        <span>
          <strong>{Math.round(route.repetition * 100)}%</strong> walked again
        </span>
      </div>
      {route.uncertain && (
        <p className="access-note">
          Some trail access is uncertain. Check access before heading out.
        </p>
      )}
      <Elevation route={route} />
      <div className="route-actions">
        <a
          className="primary button"
          href={`/api/search/${encodeURIComponent(searchId)}/routes/${encodeURIComponent(route.id)}.gpx`}
          download
        >
          Download GPX
        </a>
        <button type="button" onClick={onFit}>
          Show on map
        </button>
      </div>
      {!!route.trailNames.length && (
        <div className="trail-names">
          <h3>Along the way</h3>
          <p>{[...new Set(route.trailNames)].join(" · ")}</p>
        </div>
      )}
      <p className="quiet">
        Starts at {route.geometry[0]?.[1].toFixed(5)},{" "}
        {route.geometry[0]?.[0].toFixed(5)}. Mapped routes may not reflect
        current trail conditions.
      </p>
    </section>
  );
}

function progressLabel(search: SearchSnapshot) {
  if (search.status === "running") return "Finding loops…";
  if (search.status === "complete") return "Search complete";
  if (search.status === "stopped") return "Search stopped";
  if (search.status === "limited") return "Search unfinished";
  return "Search interrupted";
}

export function App() {
  const [dataset, setDataset] = useState<DatasetInfo>();
  const [startupError, setStartupError] = useState("");
  const [area, setArea] = useState<Bounds | null>(null);
  const [areaName, setAreaName] = useState("Visible map area");
  const [camera, setCamera] = useState<{ bounds: Bounds; revision: number }>();
  const [distance, setDistance] = useState<[string, string]>(["5", "12"]);
  const [gain, setGain] = useState<[string, string]>(["0", "4000"]);
  const [repetition, setRepetition] = useState("20");
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const [search, setSearch] = useState<SearchSnapshot>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
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
        setAreaName(info.name);
        setCamera({ bounds: info.bounds, revision: 0 });
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
              setArea(snapshot.query.area);
              setAreaName("Current search area");
              setCamera({ bounds: snapshot.query.area, revision: 1 });
              setDistance(
                snapshot.query.distance.map((value) =>
                  String(Number((value / MILE).toFixed(3))),
                ) as [string, string],
              );
              setGain(
                snapshot.query.gain.map((value) =>
                  String(Math.round(value / FOOT)),
                ) as [string, string],
              );
              setRepetition(
                String(Math.round(snapshot.query.repetition * 100)),
              );
              setIncludeUnknown(snapshot.query.includeUnknown);
            })
            .catch((failure) => {
              if (!controller.signal.aborted) {
                if (failure.status === 404) remember(null);
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
          setError("");
        }
        if (snapshot.status !== "running") return;
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Connection lost. Reconnecting…",
        );
        if ((failure as { status?: number }).status === 404) {
          setSearch(undefined);
          setSelectedId(null);
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
    if (!area || busy) return;
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
  const moveTo = (bounds: Bounds) =>
    setCamera((current) => ({
      bounds,
      revision: (current?.revision ?? 0) + 1,
    }));
  const pickRoute = (id: string) => {
    setSelectedId(id);
    document
      .getElementById("results")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <div className="app">
      <header className="app-header">
        <a href="/" className="brand" aria-label="Alpine Loop home">
          <span className="brand-mark" aria-hidden="true">
            ↺
          </span>{" "}
          Alpine Loop
        </a>
        <span className="tagline">A good hike comes full circle.</span>
        <span className="dataset-label">
          {dataset?.name ?? "Washington trails"}
        </span>
      </header>
      {!dataset ? (
        <main className="startup" role={startupError ? "alert" : "status"}>
          <h1>
            {startupError
              ? "Trail data is unavailable"
              : "Opening the trail map…"}
          </h1>
          <p>{startupError || "Getting ready to find your next loop."}</p>
          {startupError && (
            <button type="button" onClick={() => window.location.reload()}>
              Try again
            </button>
          )}
        </main>
      ) : (
        <main className="workspace">
          <aside className="sidebar" aria-label="Route planner">
            <form className="planner" onSubmit={(event) => void launch(event)}>
              <div className="section-kicker">Choose your next hike</div>
              <h1>Find your loop.</h1>
              <label className="place-field" htmlFor="place">
                Search area
              </label>
              <select
                id="place"
                value=""
                onChange={(event) => {
                  const place = dataset.places[Number(event.target.value)];
                  if (place) {
                    setArea(place.bounds);
                    setAreaName(place.name);
                    moveTo(place.bounds);
                  }
                }}
              >
                <option value="" disabled>
                  {areaName}
                </option>
                {dataset.places.map((place, index) => (
                  <option key={place.name} value={index}>
                    {place.name}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                Choose a region, use the visible map, or draw an area.
              </p>
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
                <span>Maximum portion walked again</span>
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
                A 2 mi approach + 6 mi loop + 2 mi return is 20% walked again.
              </p>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={includeUnknown}
                  onChange={(event) => setIncludeUnknown(event.target.checked)}
                />{" "}
                Include trails with uncertain access
              </label>
              <button
                className="primary search-button"
                type="submit"
                disabled={busy || !area}
              >
                {busy
                  ? "Please wait…"
                  : running
                    ? "Replace current search"
                    : "Search this area"}
                <span aria-hidden="true">↗</span>
              </button>
              {running && (
                <p className="field-hint">
                  Starting another search stops this one.
                </p>
              )}
            </form>
            {error && (
              <div className="error-banner" role="alert">
                <p>{error}</p>
                {running && (
                  <button
                    type="button"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Reconnect now
                  </button>
                )}
              </div>
            )}
            <section
              id="results"
              className="results"
              aria-label="Search results"
            >
              {search ? (
                <>
                  <div className="results-heading">
                    <h2>{progressLabel(search)}</h2>
                    {running && (
                      <button
                        type="button"
                        onClick={() => void stop()}
                        disabled={busy}
                      >
                        Stop
                      </button>
                    )}
                  </div>
                  <p className="progress-text" role="status">
                    {search.progress.attemptedStarts} of{" "}
                    {search.progress.totalStarts} starts attempted ·{" "}
                    {search.progress.completedStarts} fully explored
                  </p>
                  {running && (
                    <progress
                      aria-label="Starts attempted"
                      value={search.progress.attemptedStarts}
                      max={Math.max(1, search.progress.totalStarts)}
                    />
                  )}
                  <p className="query-summary">
                    {miles(search.query.distance[0])}–
                    {miles(search.query.distance[1])} mi ·{" "}
                    {feet(search.query.gain[0])}–{feet(search.query.gain[1])} ft
                    · ≤{Math.round(search.query.repetition * 100)}% walked again
                  </p>
                  {search.status !== "running" &&
                    search.status !== "complete" && (
                      <p className="search-notice">
                        {search.reason ||
                          (search.status === "stopped"
                            ? "Stopped early. Routes found so far remain available."
                            : "Some starts were not fully explored. There may be more matching routes.")}
                      </p>
                    )}
                  {selected ? (
                    <RouteDetails
                      route={selected}
                      searchId={search.id}
                      onBack={() => {
                        const id = selected.id;
                        setSelectedId(null);
                        requestAnimationFrame(() =>
                          document.getElementById(`route-${id}`)?.focus(),
                        );
                      }}
                      onFit={() => moveTo(routeBounds(selected))}
                    />
                  ) : (
                    <>
                      <p className="result-count">
                        {search.routes.length} matching{" "}
                        {search.routes.length === 1 ? "route" : "routes"}
                        <span>Every route meets your constraints.</span>
                      </p>
                      {search.routes.length ? (
                        <ol className="route-list">
                          {search.routes.map((route, index) => (
                            <li key={route.id}>
                              <button
                                id={`route-${route.id}`}
                                className="route-card"
                                type="button"
                                onClick={() => pickRoute(route.id)}
                              >
                                <span className="route-number">
                                  {index + 1}
                                </span>
                                <span className="route-card-content">
                                  <span className="route-metrics">
                                    <strong>{miles(route.distance)} mi</strong>
                                    <strong>↑ {feet(route.gain)} ft</strong>
                                    <span>
                                      {Math.round(route.repetition * 100)}%
                                      again
                                    </span>
                                  </span>
                                  <span className="route-name">
                                    {route.startName ||
                                      "Unnamed starting point"}
                                  </span>
                                  <span className="route-kind">
                                    {route.kind === "lollipop"
                                      ? "Lollipop"
                                      : "Loop"}
                                    {route.uncertain
                                      ? " · Access uncertain"
                                      : ""}
                                  </span>
                                </span>
                                <span
                                  className="route-arrow"
                                  aria-hidden="true"
                                >
                                  →
                                </span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="empty-state">
                          {running
                            ? "Exploring the trail network. Routes appear here as they are found."
                            : search.status === "complete"
                              ? "No loops meet these constraints. Try a wider area or adjust the distance, climb, or repetition."
                              : "No matching routes were found before the search ended."}
                        </p>
                      )}
                    </>
                  )}
                </>
              ) : (
                <div className="intro">
                  <span aria-hidden="true">↺</span>
                  <h2>Your next loop starts here.</h2>
                  <p>
                    Pick an area and set your limits. We’ll explore each
                    eligible starting point and show matching loops as we find
                    them.
                  </p>
                </div>
              )}
            </section>
            <footer className="data-notes">
              <p>
                Trail data: {dataset.sourceDate} ·{" "}
                {dataset.startCount.toLocaleString()} starting points
              </p>
              {dataset.limitations.length > 0 && (
                <details>
                  <summary>Coverage and limitations</summary>
                  <ul>
                    {dataset.limitations.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div>
                {dataset.attribution.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.name} · {source.license}
                  </a>
                ))}
              </div>
            </footer>
          </aside>
          {camera && (
            <HikeMap
              dataset={dataset}
              area={area}
              routes={search?.routes ?? []}
              selectedId={selectedId}
              camera={camera}
              onArea={(bounds) => {
                setArea(bounds);
                setAreaName("Selected map area");
              }}
              onSelect={pickRoute}
            />
          )}
        </main>
      )}
    </div>
  );
}
