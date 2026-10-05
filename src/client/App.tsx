import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  Bounds,
  HikeRoute,
  RouteChoice,
  RouteSummary,
  RouteView,
  SearchQuery,
  SearchSnapshot,
} from "../model.js";
import { DEFAULT_ROAD_LIMITS, ROUTES_PER_PAGE } from "../model.js";
import type { CatalogView, Coverage, DownloadSnapshot } from "../data-format.js";
import { HikeMap } from "./Map.js";

const MILE = 1609.344;
const FOOT = 0.3048;
const miles = (meters: number) => (meters / MILE).toFixed(1);
const feet = (meters: number) => Math.round(meters / FOOT).toLocaleString();
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
const roadExplanation =
  "Includes roads, forest vehicle tracks and sidewalk connections, based on mapped classification. Return walks count too.";
const routeName = (route: RouteSummary) =>
  route.trailNames.slice(0, 2).join(" / ") || route.startName || "Unnamed trails";
const startName = (route: RouteSummary) => {
  const position = `${route.startPosition[1].toFixed(5)}, ${route.startPosition[0].toFixed(5)}`;
  return !route.startName ? position
    : /^(Trail entrance|Mapped parking access)$/.test(route.startName) ? `${route.startName} · ${position}` : route.startName;
};
const pageQuery = (offset: number, groupId?: string) =>
  `?offset=${offset}${groupId ? `&group=${encodeURIComponent(groupId)}` : ""}`;
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
      { status: response.status, sections: data?.sections, bytes: data?.bytes },
    );
  return data as T;
}
const routeBounds = (route: HikeRoute): Bounds => {
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [longitude, latitude] of route.geometry) {
    bounds[0] = Math.min(bounds[0], longitude);
    bounds[1] = Math.min(bounds[1], latitude);
    bounds[2] = Math.max(bounds[2], longitude);
    bounds[3] = Math.max(bounds[3], latitude);
  }
  return bounds;
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
  backDisabled,
  children,
  onReverse,
  reversing,
  reversed,
  directionError,
  onRetry,
}: {
  route: RouteChoice;
  searchId: string;
  onBack: () => void;
  backDisabled: boolean;
  children: ReactNode;
  onReverse: () => void;
  reversing: boolean;
  reversed: boolean;
  directionError: string;
  onRetry: () => void;
}) {
  return (
    <section className="route-detail" aria-label="Route details">
      <button type="button" className="text-button" onClick={onBack} disabled={backDisabled}>
        ← All hikes
      </button>
      <h2 id="route-detail-heading" tabIndex={-1}>
        {routeName(route)}
      </h2>
      {reversing ? (
        <div className="direction-status" role={directionError ? "alert" : "status"}>
          <p>{directionError || "Loading reverse direction…"}</p>
          {directionError && <button type="button" onClick={onRetry}>Retry reverse direction</button>}
        </div>
      ) : <>
      <div className="starting-point">
        <h3>Starting point</h3>
        <p>{startName(route)}</p>
        {children}
      </div>
      <p className="route-kind">
        {route.kind === "lollipop"
          ? "Lollipop · an out-and-back approach to a loop"
          : "Loop · returns without retracing trail"}
      </p>
      {route.reverseId && (
        <button type="button" className="text-button reverse-direction" onClick={onReverse}>
          {reversed ? "Use original direction" : "Reverse direction"}
        </button>
      )}
      {reversed && <p className="field-hint" role="status">Reverse direction selected. GPX follows this direction.</p>}
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
      <div className="road-detail">
        <p>
          <strong>Road connections: </strong>
          {Number.isFinite(route.roadDistance)
            ? `${(route.roadDistance / MILE).toFixed(2)} mi (${(100 * route.roadDistance / route.distance).toFixed(1)}%)`
            : "Not recorded for this earlier search."}
        </p>
        <p className="field-hint">{roadExplanation}</p>
      </div>
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
        Start: {route.startPosition[1].toFixed(5)},{" "}
        {route.startPosition[0].toFixed(5)}
      </p>
      </>}
    </section>
  );
}

function progressLabel(search: SearchSnapshot) {
  if (search.status === "running") return "Searching";
  if (search.status === "complete") return "Search complete";
  if (search.status === "stopped") return "Stopped early";
  if (search.status === "limited") return "Search incomplete";
  return "Search interrupted";
}

export function App() {
  const [dataset, setDataset] = useState<CatalogView>();
  const [pendingDownload, setPendingDownload] = useState<{ query: SearchQuery; coverage: Coverage } | null>(null);
  const [download, setDownload] = useState<DownloadSnapshot | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [downloadRetry, setDownloadRetry] = useState(0);
  const downloadQuery = useRef<SearchQuery | null>(null);
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
    padding?: number;
  }>();
  const [distance, setDistance] = useState<[string, string]>(["5", "12"]);
  const [gain, setGain] = useState<[string, string]>(["0", "4000"]);
  const [repetition, setRepetition] = useState("20");
  const [roadMiles, setRoadMiles] = useState(
    String(DEFAULT_ROAD_LIMITS.distance / MILE),
  );
  const [roadPercent, setRoadPercent] = useState(
    String(DEFAULT_ROAD_LIMITS.fraction * 100),
  );
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const [search, setSearch] = useState<SearchSnapshot>();
  const [selected, setSelected] = useState<RouteChoice | null>(null);
  const [reverseTarget, setReverseTarget] = useState<string | null>(null);
  const overviewOffset = useRef(0);
  const originalDirectionId = useRef<string | null>(null);
  const [showStarts, setShowStarts] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [retry, setRetry] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const pageOperation = useRef<AbortController | null>(null);
  const [geometry, setGeometry] = useState<RouteView | null>(null);
  const [routeError, setRouteError] = useState("");
  const [routeRetry, setRouteRetry] = useState(0);
  const selectedId = selected?.id ?? null;
  const running = search?.status === "running";
  const downloading = download?.status === "running";
  const choosingDownload = !!pendingDownload;
  const activeId = editing ? null : (reverseTarget ?? selectedId ?? hoveredId);
  const activeRoute = geometry?.id === activeId ? geometry : null;
  const acceptSnapshot = (snapshot: SearchSnapshot) => {
    // Progress-only polls must not rebuild the map's start markers.
    setSearch((current) =>
      current?.id === snapshot.id &&
      current.offset === snapshot.offset &&
      current.groupId === snapshot.groupId &&
      current.routes.length === snapshot.routes.length &&
      current.routes.every(
        (route, index) => route.id === snapshot.routes[index]?.id &&
          route.groupSize === snapshot.routes[index]?.groupSize &&
          route.reverseId === snapshot.routes[index]?.reverseId,
      )
        ? { ...snapshot, routes: current.routes }
        : snapshot,
    );
    setSelected((current) => {
      if (!current) return null;
      const entry = snapshot.routes.find(route => route.id === current.id || route.reverseId === current.id);
      const reverseId = current.reverseId ?? (entry?.id === current.id ? entry.reverseId : entry?.id);
      const groupSize = Math.max(current.groupSize,
        snapshot.groupId === current.groupId ? snapshot.pageTotal
          : snapshot.routes.find(route => route.groupId === current.groupId)?.groupSize ?? 0);
      return current.groupSize === groupSize && current.reverseId === reverseId
        ? current : { ...current, groupSize, reverseId };
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      request<CatalogView>("/api/catalog", controller.signal),
      request<SearchSnapshot | null>("/api/search", controller.signal),
      request<DownloadSnapshot | null>("/api/downloads", controller.signal),
    ])
      .then(([info, snapshot, transfer]) => {
        if (controller.signal.aborted) return;
        setArea(info.bounds);
        setCamera({ bounds: info.bounds, revision: 0, selectArea: true });
        if (snapshot) {
          setSearch(snapshot);
          restoreDraft(snapshot);
          setEditing(false);
        }
        setDownload(transfer);
        setDataset(info);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setStartupError(failure.message);
      });
    return () => {
      controller.abort();
      operation.current?.abort();
      pageOperation.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (download?.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await request<DownloadSnapshot | null>("/api/downloads", controller.signal);
        if (controller.signal.aborted) return;
        setDownloadError("");
        if (!snapshot) {
          downloadQuery.current = null;
          setDownload(null);
          setError("The download is no longer available. The server may have restarted. Try your search again.");
          return;
        }
        if (snapshot.status !== "running") {
          await finishDownload(snapshot, controller.signal);
          return;
        }
        setDownload(snapshot);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setDownloadError(failure instanceof Error ? failure.message : "Connection lost. Reconnecting…");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 750);
    };
    timer = setTimeout(() => void poll(), 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [download?.status, downloadRetry]);

  useEffect(() => {
    if (pendingDownload) document.getElementById("confirm-download")?.focus();
  }, [pendingDownload]);

  useEffect(() => {
    if (!search || search.status !== "running" || busy || loadingPage) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await request<SearchSnapshot>(
          `/api/search/${encodeURIComponent(search.id)}${pageQuery(search.offset, search.groupId)}`,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          acceptSnapshot(snapshot);
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
          setSelected(null);
          setReverseTarget(null);
          setEditing(true);
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
  }, [search?.id, search?.status, search?.offset, search?.groupId, retry, busy, loadingPage]);

  useEffect(() => {
    setRouteError("");
    setGeometry(null);
    if (!search || !activeId) return;
    const controller = new AbortController();
    void request<RouteView>(
      `/api/search/${encodeURIComponent(search.id)}/routes/${encodeURIComponent(activeId)}`,
      controller.signal,
    )
      .then((route) => {
        if (controller.signal.aborted) return;
        setGeometry(route);
        const { geometry: _coordinates, ...choice } = route;
        setSelected(current => {
          if (!current || (current.id !== route.id && current.reverseId !== route.id)) return current;
          // A delayed detail response must not erase alternatives discovered by a newer poll.
          return { ...choice, groupSize: Math.max(choice.groupSize, current.groupSize),
            reverseId: choice.reverseId ?? (current.id === choice.id ? current.reverseId : current.id) };
        });
        setReverseTarget(null);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setRouteError(
            failure instanceof Error
              ? failure.message
              : "The route drawing could not load.",
          );
      });
    return () => controller.abort();
  }, [search?.id, activeId, routeRetry]);

  useEffect(() => {
    if (selectedId && activeRoute?.id === selectedId)
      moveTo(routeBounds(activeRoute));
  }, [selectedId, activeRoute]);

  const changePage = async (offset: number, groupId?: string, focusId = "page-summary") => {
    if (!search || busy || loadingPage) return;
    const controller = new AbortController();
    pageOperation.current = controller;
    setLoadingPage(true);
    setHoveredId(null);
    setError("");
    try {
      const snapshot = await request<SearchSnapshot>(
        `/api/search/${encodeURIComponent(search.id)}${pageQuery(offset, groupId)}`,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        acceptSnapshot(snapshot);
        if (!groupId) setSelected(null);
        setConnectionError("");
        requestAnimationFrame(() =>
          document.getElementById(focusId)?.focus(),
        );
        return true;
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "This results page could not load. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setLoadingPage(false);
    }
  };

  const launch = async (event: FormEvent) => {
    event.preventDefault();
    if (!area || busy || drawing || downloading || pendingDownload) return;
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
    const roadDistance = Number(roadMiles),
      roadFraction = Number(roadPercent);
    if (
      !roadMiles ||
      !roadPercent ||
      !Number.isFinite(roadDistance) ||
      roadDistance < 0 ||
      !Number.isFinite(roadFraction) ||
      roadFraction < 0 ||
      roadFraction > 100
    ) {
      setError(
        "Road mileage must be zero or greater, and its percentage must be 0–100%.",
      );
      return;
    }
    const query: SearchQuery = {
      area: [...area],
      distance: [distances[0]! * MILE, distances[1]! * MILE],
      gain: [gains[0]! * FOOT, gains[1]! * FOOT],
      repetition: repeated / 100,
      includeUnknown,
      roads: { distance: roadDistance * MILE, fraction: roadFraction / 100 },
    };
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      const coverage = await request<Coverage>("/api/coverage", controller.signal, query);
      if (controller.signal.aborted) return;
      if (coverage.missing.length) {
        setDownload(null);
        setPendingDownload({ query, coverage });
      }
      else await beginSearch(query);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "Could not check trail coverage. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const beginSearch = async (query: SearchQuery) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setShowStarts(false);
    setReverseTarget(null);
    setHoveredId(null);
    try {
      if (search?.status === "running") {
        const stopped = await request<SearchSnapshot>(
          `/api/search/${encodeURIComponent(search.id)}/stop${pageQuery(search.offset, search.groupId)}`,
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
        setSelected(null);
        overviewOffset.current = 0;
        setEditing(false);
        setConnectionError("");
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejection = failure as Error & { status?: number; sections?: string[]; bytes?: number };
        if (rejection.status === 409 && Array.isArray(rejection.sections)) {
          setPendingDownload({ query, coverage: {
            sections: rejection.sections, missing: rejection.sections, bytes: rejection.bytes ?? 0,
          } });
          setEditing(true);
        } else setError(failure instanceof Error ? failure.message : "Search could not start.");
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const finishDownload = async (snapshot: DownloadSnapshot, signal: AbortSignal) => {
    const info = await request<CatalogView>("/api/catalog", signal);
    if (signal.aborted) return;
    setDataset(info);
    setDownload(snapshot);
    const query = snapshot.status === "complete" ? downloadQuery.current : null;
    downloadQuery.current = null;
    if (query) await beginSearch(query);
  };
  const beginDownload = async (sections: string[], query: SearchQuery | null = null) => {
    if (busy || downloading) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    downloadQuery.current = query;
    setBusy(true);
    setError("");
    setDownloadError("");
    try {
      const snapshot = await request<DownloadSnapshot>("/api/downloads", controller.signal, { sections });
      if (controller.signal.aborted) return;
      setPendingDownload(null);
      if (snapshot.status === "running") setDownload(snapshot);
      else await finishDownload(snapshot, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) {
        downloadQuery.current = null;
        setError(failure instanceof Error ? failure.message : "Download could not start. Try again.");
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const stopDownload = async () => {
    if (!downloading || busy) return;
    downloadQuery.current = null;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setDownloadError("");
    try {
      const snapshot = await request<DownloadSnapshot>("/api/downloads/stop", controller.signal, {});
      await finishDownload(snapshot, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted)
        setDownloadError(failure instanceof Error ? failure.message : "Could not stop the download. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const stop = async () => {
    if (!search || busy) return;
    pageOperation.current?.abort();
    setLoadingPage(false);
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      const snapshot = await request<SearchSnapshot>(
        `/api/search/${encodeURIComponent(search.id)}/stop${pageQuery(search.offset, search.groupId)}`,
        controller.signal,
        {},
      );
      if (!controller.signal.aborted) {
        acceptSnapshot(snapshot);
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
  const moveTo = (bounds: Bounds, selectArea = false, padding = 40) =>
    setCamera((current) => ({
      bounds,
      revision: (current?.revision ?? 0) + 1,
      selectArea,
      padding,
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
    const roads = snapshot.query.roads ?? DEFAULT_ROAD_LIMITS;
    setRoadMiles(String(roads.distance / MILE));
    setRoadPercent(String(roads.fraction * 100));
    setIncludeUnknown(snapshot.query.includeUnknown);
    setShowStarts(false);
    setReverseTarget(null);
    setHoveredId(null);
    moveTo(snapshot.query.area, false, 0);
  };
  const pickRoute = (id: string) => {
    const route = search?.routes.find((route) => route.id === id);
    if (!route || editing) return;
    pageOperation.current?.abort();
    setLoadingPage(false);
    if (!search?.groupId) overviewOffset.current = search?.offset ?? 0;
    originalDirectionId.current = route.id;
    setSelected(route);
    setShowStarts(false);
    setReverseTarget(null);
    setHoveredId(null);
    requestAnimationFrame(() => document.getElementById("route-detail-heading")?.focus());
  };
  const toggleStarts = () => {
    if (!selected || busy || loadingPage) return;
    setShowStarts(!showStarts);
    if (!showStarts && search?.groupId !== selected.groupId)
      void changePage(0, selected.groupId, "starting-point-heading");
  };
  const backToHikes = () => {
    if (!search || busy || loadingPage) return;
    const focusId = `group-${selected?.groupId}`;
    const finish = () => {
      setSelected(null);
      setShowStarts(false);
      setReverseTarget(null);
      setHoveredId(null);
      moveTo(search.query.area, false, 0);
      requestAnimationFrame(() => document.getElementById(focusId)?.focus());
    };
    if (search.groupId) void changePage(overviewOffset.current, undefined, focusId).then(changed => {
      if (changed) finish();
    });
    else finish();
  };
  const currentRoutes = search?.routes ?? [];
  const mapRoutes = selected && (!showStarts || search?.groupId !== selected.groupId) ? [selected] : currentRoutes;
  const mapActiveId = mapRoutes.find(route => route.id === activeId || route.reverseId === activeId)?.id ?? activeId;
  const selectionNote = search?.selectionNote;
  const pages = search && search.pageTotal > ROUTES_PER_PAGE ? (
    <nav className="result-pages" aria-label={search.groupId ? "Starting point pages" : "Hike pages"} aria-busy={loadingPage}>
      <button type="button" disabled={busy || loadingPage || search.offset === 0}
        onClick={() => void changePage(Math.max(0, search.offset - ROUTES_PER_PAGE), search.groupId)}>
        Previous
      </button>
      <span id="page-summary" tabIndex={-1} aria-live="polite">
        {loadingPage ? "Loading…"
          : `${search.offset + 1}–${search.offset + currentRoutes.length} of ${search.pageTotal.toLocaleString()} ${search.groupId ? "starting points" : "hikes"}`}
      </span>
      <button type="button" disabled={busy || loadingPage || search.offset + ROUTES_PER_PAGE >= search.pageTotal}
        onClick={() => void changePage(search.offset + ROUTES_PER_PAGE, search.groupId)}>
        Next
      </button>
    </nav>
  ) : null;
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
              {pendingDownload && (
                <section className="download-panel" aria-labelledby="download-heading">
                  <h2 id="download-heading">Download trails for this search</h2>
                  <p>{megabytes(pendingDownload.coverage.bytes)} total. Downloaded sections stay on this computer for later searches.</p>
                  <ul>
                    {pendingDownload.coverage.missing.map(id => (
                      <li key={id}>{dataset.sections.find(section => section.id === id)?.name ?? id}</li>
                    ))}
                  </ul>
                  {pendingDownload.coverage.coverageNote && <p>{pendingDownload.coverage.coverageNote}</p>}
                  <div className="download-actions">
                    <button id="confirm-download" className="primary" type="button" disabled={busy}
                      onClick={() => void beginDownload(pendingDownload.coverage.missing, pendingDownload.query)}>
                      Download and search
                    </button>
                    <button type="button" disabled={busy} onClick={() => setPendingDownload(null)}>Cancel</button>
                  </div>
                </section>
              )}
              {download && (
                <section className="download-panel" aria-label="Trail download">
                  <h2>{downloading ? "Downloading trail sections"
                    : download.status === "complete" ? "Trail sections ready"
                    : download.status === "stopped" ? "Download stopped" : "Download failed"}</h2>
                  <p className="download-names">{download.sections.map(id =>
                    dataset.sections.find(section => section.id === id)?.name ?? id).join(" · ")}</p>
                  {downloading && <progress aria-label="Trail download progress"
                    value={Math.min(download.completedBytes, download.totalBytes)} max={Math.max(1, download.totalBytes)} />}
                  <p role="status">{megabytes(download.completedBytes)} of {megabytes(download.totalBytes)}
                    {downloading && downloadQuery.current ? ". Your search starts when the download finishes." : ""}</p>
                  {download.reason && <p role={download.status === "failed" ? "alert" : undefined}>{download.reason}</p>}
                  {downloadError && <p role="alert">{downloadError}</p>}
                  <div className="download-actions">
                    {downloading ? <>
                      <button type="button" disabled={busy} onClick={() => void stopDownload()}>Cancel download</button>
                      {downloadError && <button type="button" disabled={busy}
                        onClick={() => setDownloadRetry(value => value + 1)}>Reconnect</button>}
                    </> : <button type="button" onClick={() => setDownload(null)}>Dismiss</button>}
                  </div>
                </section>
              )}
              {editing ? (
                <form
                  className="planner"
                  onSubmit={(event) => void launch(event)}
                >
                  <fieldset className="planner-fields" disabled={busy || downloading || choosingDownload}>
                  <div className="section-heading">
                    <h2>Where</h2>
                    {search && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
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
                  {dataset.places.length === 1 ? (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setAreaMode("view");
                        moveTo(dataset.bounds, true);
                      }}
                    >
                      Show available trails
                    </button>
                  ) : (
                    <>
                      <label className="visually-hidden" htmlFor="place">
                        Choose an area around a region
                      </label>
                      <select
                        id="place"
                        value=""
                        onChange={(event) => {
                          const place = dataset.places[Number(event.target.value)];
                          if (place) {
                            setArea(place.bounds);
                            setAreaMode("drawn");
                            moveTo(place.bounds);
                          }
                        }}
                      >
                        <option value="" disabled>
                          Choose an area around…
                        </option>
                        {dataset.places.map((place, index) => (
                          <option key={place.name} value={index}>
                            {place.name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <p className="area-description">
                    {areaMode === "drawn"
                      ? "Starts inside the outlined rectangle."
                      : areaMode === "retained"
                        ? "Previous search area. Pan the map to change it."
                        : "Starts in the visible map area. Pan or zoom to choose."}
                  </p>
                  <details className="sections-panel">
                    <summary>Trail sections <span>{dataset.sections.filter(section => section.installed).length} of {dataset.sections.length} downloaded</span></summary>
                    <p>Choose a section to see its area, or download it for later. Searching an area prompts for any missing sections.</p>
                    <ul className="sections-list">
                      {dataset.sections.map(section => <li key={section.id}>
                        <div>
                          <button className="section-name" type="button" onClick={() => {
                            setArea(section.bounds);
                            setAreaMode("drawn");
                            moveTo(section.bounds);
                          }}>{section.name}</button>
                          <span>{section.installed ? "Downloaded · " : ""}{megabytes(section.bytes)}</span>
                        </div>
                        {!section.installed && <button type="button" aria-label={`Download ${section.name}`}
                          onClick={() => void beginDownload([section.id])}>Download</button>}
                      </li>)}
                    </ul>
                    {!dataset.sections.length && <p>No prepared sections are available yet.</p>}
                    {!!dataset.unavailable?.length && <ul className="unavailable-sections">
                      {dataset.unavailable.map(region => <li key={region.name}>
                        <strong>{region.name}</strong><span>{region.reason}</span>
                      </li>)}
                    </ul>}
                  </details>
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
                  <details
                    className="road-controls"
                    onInvalidCapture={(event) => {
                      event.currentTarget.open = true;
                    }}
                  >
                    <summary>
                      Road connections
                      <span>
                        At most {roadMiles || "—"} mi and {roadPercent || "—"}%
                      </span>
                    </summary>
                    <div className="road-inputs">
                      <label htmlFor="road-miles">
                        Maximum miles
                        <input
                          id="road-miles"
                          type="number"
                          min="0"
                          step="any"
                          required
                          value={roadMiles}
                          onChange={(event) => setRoadMiles(event.target.value)}
                        />
                      </label>
                      <label htmlFor="road-percent">
                        Maximum percentage
                        <input
                          id="road-percent"
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          required
                          value={roadPercent}
                          onChange={(event) => setRoadPercent(event.target.value)}
                        />
                      </label>
                    </div>
                    <p className="field-hint">Both limits apply. {roadExplanation}</p>
                  </details>
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
                  </fieldset>
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
                          disabled={busy || loadingPage}
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
                        <br />
                        {search.query.roads
                          ? `Roads: at most ${(search.query.roads.distance / MILE).toLocaleString()} mi and ${(search.query.roads.fraction * 100).toLocaleString()}%`
                          : "Road limits not recorded for this earlier search"}
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
                          {search.groupCount.toLocaleString()} {search.groupCount === 1 ? "hike" : "hikes"} found
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
                      <p className="route-count">
                        Small path variations are combined; each shown route meets your limits.
                      </p>
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
                      {search.coverageNote && search.coverageNote !== search.reason && (
                        <p className="search-notice">{search.coverageNote}</p>
                      )}
                      {search.status !== "running" &&
                        search.status !== "complete" && (
                          <p className="search-notice">
                            {search.reason ||
                              "More matching routes may exist. Routes found so far are kept."}
                          </p>
                        )}
                      {selectionNote && (
                        <details className="selection-note">
                          <summary>How hikes are selected</summary>
                          <p>{selectionNote}</p>
                        </details>
                      )}
                      {!selected && pages}
                      {selected ? (
                          <RouteDetails
                            route={selected}
                            searchId={search.id}
                            onBack={backToHikes}
                            backDisabled={busy || loadingPage}
                            onReverse={() => {
                              if (!selected.reverseId) return;
                              setReverseTarget(selected.reverseId);
                              requestAnimationFrame(() => document.getElementById("route-detail-heading")?.focus());
                            }}
                            reversing={reverseTarget !== null}
                            reversed={selected.id !== originalDirectionId.current}
                            directionError={routeError}
                            onRetry={() => setRouteRetry(value => value + 1)}
                          >
                            {(selected.groupSize > 1 || showStarts) && <>
                              <button id="starting-point-toggle" type="button" className="text-button"
                                disabled={busy || loadingPage} aria-expanded={showStarts} aria-controls="starting-point-choices"
                                onClick={toggleStarts}>
                                {showStarts ? "Close starting points" : `Choose from ${selected.groupSize.toLocaleString()} starting points`}
                              </button>
                              {showStarts && <div id="starting-point-choices" className="starting-point-choices" aria-busy={loadingPage}>
                                <h3 id="starting-point-heading" tabIndex={-1}>Starting points for this hike</h3>
                                {search.groupId === selected.groupId ? <>
                                  {pages}
                                  <ul className="start-list">
                                    {currentRoutes.map(route => <li key={route.startId}>
                                      <button type="button" disabled={busy || loadingPage}
                                        aria-current={route.startId === selected.startId ? "true" : undefined}
                                        onClick={() => pickRoute(route.id)}>
                                        <span>{startName(route)}</span>
                                        <small>{miles(route.distance)} mi · ↑ {feet(route.gain)} ft</small>
                                      </button>
                                    </li>)}
                                  </ul>
                                </> : loadingPage ? <p role="status">Loading starting points…</p>
                                  : <button type="button" disabled={busy}
                                      onClick={() => void changePage(0, selected.groupId, "starting-point-heading")}>
                                      Retry starting points
                                    </button>}
                              </div>}
                            </>}
                          </RouteDetails>
                      ) : currentRoutes.length ? (
                        <ol className="route-list">
                          {currentRoutes.map((route) => (
                            <li key={route.groupId}>
                              <button
                                id={`group-${route.groupId}`}
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
                                {route.trailNames.length > 2 && <span className="route-trails">
                                  Also: {route.trailNames.slice(2).join(" · ")}
                                </span>}
                                <span className="route-start">
                                  From {startName(route)}
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
                                  {route.roadDistance > 0 ? ` · ${(route.roadDistance / MILE).toFixed(2)} mi road connections` : ""}
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
          locked={busy || downloading || choosingDownload}
          drawn={areaMode === "drawn"}
          routes={editing ? [] : mapRoutes}
          activeRoute={activeRoute}
          selectedId={mapActiveId}
          routeNotice={reverseTarget
            ? routeError ? "" : "Loading reverse direction…"
            : activeId
            ? routeError || (!activeRoute ? "Loading route drawing…" : "")
            : ""}
          onRetryRoute={routeError && !reverseTarget
            ? () => setRouteRetry((value) => value + 1)
            : undefined}
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
          onPreview={setHoveredId}
        />
      ) : (
        <div className="map-placeholder" />
      )}
    </main>
  );
}
