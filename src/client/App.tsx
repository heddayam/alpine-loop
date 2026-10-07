import {
  useEffect,
  useRef,
  useState,
  useMemo,
  lazy,
  Suspense,
  type FormEvent,
} from "react";
import type {
  Bounds,
  RouteSummary,
  RouteView,
  SearchQuery,
  JobSnapshot,
  RouteLocation,
  Position,
} from "../model.js";
import { DEFAULT_ROAD_LIMITS } from "../model.js";
import type {
  CatalogView,
  Coverage,
  DownloadSnapshot,
} from "../data-format.js";
import {
  JobsDialog,
  activeJob,
  hasSavedResults,
  requestSummary,
  savedResultsURL,
  elapsed,
  storage,
} from "./JobsDialog.js";

import { RegionPicker, regionLabel } from "./RegionPicker.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { locationsInView } from "./clusters.js";
import { ElevationProfile, createProfileCursor } from "./ElevationProfile.js";
import { request } from "./request.js";
import { useJobs } from "./useJobs.js";
import { RouteCache } from "./RouteCache.js";
import { FixedList } from "./FixedList.js";

const HikeMap = lazy(async () => ({
  default: (await import("./Map.js")).HikeMap,
}));

const MILE = 1609.344;
const FOOT = 0.3048;
const miles = (meters: number) => (meters / MILE).toFixed(1);
const inputUnits = (value: number, unit: number) => {
  const converted = value / unit;
  const rounded = Number(converted.toPrecision(15));
  return String(rounded * unit === value ? rounded : converted);
};
const feet = (meters: number) => Math.round(meters / FOOT).toLocaleString();
const routeName = (route: RouteSummary) =>
  route.trailNames.slice(0, 2).join(" / ") ||
  route.startName ||
  "Unnamed trails";
const startName = (route: RouteSummary) => {
  const position = `${route.startPosition[1].toFixed(5)}, ${route.startPosition[0].toFixed(5)}`;
  return !route.startName
    ? position
    : /^(Trail entrance|Mapped parking access)$/.test(route.startName)
      ? `${route.startName} · ${position}`
      : route.startName;
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
  route, jobId, resultsRevision, onBack, onProfileHover,
}: {
  route: RouteView;
  jobId: string;
  resultsRevision: number;
  onBack: () => void;
  onProfileHover: (position: Position | null) => void;
}) {
  return (
    <section className="route-detail" aria-label="Route details">
      <button type="button" className="text-button" onClick={onBack}>
        ← Hikes
      </button>
      <h2 id="route-detail-heading" tabIndex={-1}>
        {routeName(route)}
      </h2>
      <div className="starting-point">
        <h3>Starting point</h3>
        <p>{startName(route)}</p>
      </div>
      <p className="route-kind">
        {route.kind === "lollipop" ? "Lollipop" : "Loop"}
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
          <dt>Repeated</dt>
          <dd>
            {Math.round(route.repetition * 100)}
            <small>%</small>
          </dd>
        </div>
      </dl>
      <ElevationProfile key={route.id} route={route} onHover={onProfileHover} />
      <div className="road-detail">
        <p>
          <strong>Road connections: </strong>
          {(route.roadDistance / MILE).toFixed(2)} mi (
          {((100 * route.roadDistance) / route.distance).toFixed(1)}%)
        </p>
      </div>
      {route.uncertain && <p className="access-note">Access uncertain</p>}
      <a
        className="primary button export-button"
        href={savedResultsURL(
          { id: jobId, resultsRevision },
          `routes/${encodeURIComponent(route.id)}.gpx`,
        )}
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
    </section>
  );
}

const regionBounds = (sections: { bounds: Bounds }[]): Bounds => [
  Math.min(...sections.map((section) => section.bounds[0])),
  Math.min(...sections.map((section) => section.bounds[1])),
  Math.max(...sections.map((section) => section.bounds[2])),
  Math.max(...sections.map((section) => section.bounds[3])),
];
const savedMap = (job: JobSnapshot): CatalogView | undefined =>
  job.inputs?.sections.length
    ? {
        id: `saved-${job.id}`,
        name: "Saved search",
        bounds: regionBounds(job.inputs.sections),
        sourceDate: job.inputs.version,
        attribution: [],
        limitations: [],
        startCount: job.progress.totalStarts,
        sections: job.inputs.sections.map((section) => ({
          ...section,
          regionId: section.id,
          sourceSegments: 0,
          startCount: 0,
          installed: true,
          bytes: 0,
        })),
      }
    : undefined;

export function App() {
  const [dataset, setDataset] = useState<CatalogView>();
  const [startupError, setStartupError] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [showSearchArea, setShowSearchArea] = useState(true);
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
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
  const [camera, setCamera] = useState<{
    bounds: Bounds;
    revision: number;
    padding?: number;
  }>();
  const jobHistory = useJobs();
  const { jobs } = jobHistory;
  const [jobsOpen, setJobsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const downloadDialog = useRef<HTMLDialogElement>(null);
  const [highlightedJob, setHighlightedJob] = useState<string | null>(null);
  const [jobActionError, setJobActionError] = useState("");
  const [pendingJob, setPendingJob] = useState<{
    id: string;
    action: string;
  } | null>(null);
  const [viewedJob, setViewedJob] = useState<JobSnapshot>();
  const [locations, setLocations] = useState<RouteLocation[]>([]);
  const [mapBounds, setMapBounds] = useState<Bounds>();
  const [resultScope, setResultScope] = useState<
    "view" | "all" | ReadonlySet<string>
  >("view");
  const [selected, setSelected] = useState<RouteView | null>(null);
  const profileCursor = useMemo(createProfileCursor, []);
  const routeCache = useRef(new RouteCache());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<RouteView | null>(null);
  const [routeError, setRouteError] = useState("");
  const [routeRetry, setRouteRetry] = useState(0);
  const focusedRouteId = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<{
    query: SearchQuery;
    coverage: Coverage;
  } | null>(null);
  const [download, setDownload] = useState<DownloadSnapshot | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [downloadRetry, setDownloadRetry] = useState(0);
  const downloadQuery = useRef<SearchQuery | null>(null);
  const operation = useRef<AbortController | null>(null);
  const viewOperation = useRef<AbortController | null>(null);
  const viewedRevisions = useRef(new Map<string, number>());
  const downloading = download?.status === "running";
  const choosingDownload = !!pendingDownload;
  const activeId = hoveredId ?? selectedId;
  const activeRoute = useMemo(
    () =>
      geometry?.id === activeId
        ? geometry
        : selected?.id === activeId && selected.geometry
          ? selected
          : null,
    [geometry, activeId, selected],
  );
  useEffect(
    () => profileCursor.set(null),
    [selectedId, resultsCollapsed, viewedJob?.id],
  );
  const sortedLocations = useMemo(
    () =>
      [...locations].sort(
        (a, b) => a.distance - b.distance || a.id.localeCompare(b.id),
      ),
    [locations],
  );
  const visibleLocations = useMemo(
    () =>
      typeof resultScope !== "string"
        ? sortedLocations.filter((route) => resultScope.has(route.id))
        : resultScope === "all"
          ? sortedLocations
          : mapBounds
            ? locationsInView(sortedLocations, mapBounds)
            : [],
    [sortedLocations, resultScope, mapBounds],
  );
  useEffect(() => {
    setHoveredId(null);
  }, [visibleLocations]);
  const mapDataset = useMemo(
    () => !showSearchArea && viewedJob ? (savedMap(viewedJob) ?? dataset) : dataset,
    [showSearchArea, viewedJob, dataset],
  );
  const regionName = (id: string) =>
    regionLabel(
      dataset?.sections.find((section) => section.id === id)?.name ?? id,
    );
  const moveTo = (bounds: Bounds, padding = 40) =>
    setCamera((current) => ({
      bounds,
      revision: (current?.revision ?? 0) + 1,
      padding,
    }));
  const clearSelection = () => {
    setHoveredId(null);
    setSelected(null);
    setSelectedId(null);
    focusedRouteId.current = null;
  };
  const localURL = (id?: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("job", id);
    else url.searchParams.delete("job");
    window.history.replaceState(null, "", url);
  };
  const closeResults = () => {
    viewOperation.current?.abort();
    setPendingJob(null);
    clearSelection();
    setViewedJob(undefined);
    setResultsCollapsed(true);
    setLocations([]);
    routeCache.current.clear();
    setGeometry(null);
    setRouteError("");
    setShowSearchArea(true);
    localURL();
  };
  const openResults = async (job: JobSnapshot) => {
    if (!hasSavedResults(job)) {
      setHighlightedJob(job.id);
      setJobsOpen(true);
      return;
    }
    viewOperation.current?.abort();
    const controller = new AbortController();
    viewOperation.current = controller;
    setPendingJob({ id: job.id, action: "open" });
    setError("");
    setJobActionError("");
    try {
      const fullJob = await request<JobSnapshot>(
        `/api/jobs/${encodeURIComponent(job.id)}`,
        controller.signal,
      );
      const positions = await request<RouteLocation[]>(
        savedResultsURL(fullJob, "locations"),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      routeCache.current.clear();
      setViewedJob(fullJob);
      setResultsCollapsed(false);
      setLocations(positions);
      setResultScope("view");
      clearSelection();
      setShowSearchArea(false);
      setJobsOpen(false);
      viewedRevisions.current.set(job.id, fullJob.resultsRevision ?? 0);
      localURL(job.id);
      const map = savedMap(fullJob) ?? dataset;
      if (map) moveTo(map.bounds);
    } catch (failure) {
      if (!controller.signal.aborted)
        setJobActionError(
          failure instanceof Error
            ? failure.message
            : "Saved results could not load.",
        );
    } finally {
      if (!controller.signal.aborted) setPendingJob(null);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void request<CatalogView>("/api/catalog", controller.signal)
      .then((info) => {
        setDataset(info);
        setCamera((current) => current ?? { bounds: info.bounds, revision: 0 });
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setStartupError(failure.message);
      });
    void request<DownloadSnapshot | null>("/api/downloads", controller.signal)
      .then(setDownload)
      .catch(() => {});
    return () => {
      controller.abort();
      operation.current?.abort();
      viewOperation.current?.abort();
    };
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("job");
    if (!id) return;
    const controller = new AbortController();
    void request<JobSnapshot>(`/api/jobs/${encodeURIComponent(id)}?inputs=false`, controller.signal)
      .then((job) => {
        if (!controller.signal.aborted) {
          jobHistory.upsert(job);
          void openResults(job);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(failure.message);
          localURL();
        }
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!activeId || !viewedJob) {
      setGeometry(null);
      return;
    }
    const controller = new AbortController();
    const key = savedResultsURL(viewedJob, `routes/${encodeURIComponent(activeId)}`);
    const publish = (route: RouteView) => {
      if (controller.signal.aborted) return;
      setGeometry(route);
      if (selectedId === route.id) {
        setSelected(route);
        if (focusedRouteId.current !== route.id) {
          focusedRouteId.current = route.id;
          requestAnimationFrame(() => document.getElementById("route-detail-heading")?.focus());
        }
      }
    };
    setRouteError("");
    const cached = selected?.id === activeId ? selected : routeCache.current.get(key);
    if (cached) publish(cached);
    else {
      setGeometry(null);
      // Intentional selection loads immediately; passing over a marker does not.
      const timer = setTimeout(() => {
        void request<RouteView>(key, controller.signal)
          .then((route) => {
            if (!controller.signal.aborted) {
              routeCache.current.add(key, route);
              publish(route);
            }
          })
          .catch((failure) => {
            if (!controller.signal.aborted) setRouteError(failure.message);
          });
      }, activeId === selectedId ? 0 : 120);
      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    }
    return () => controller.abort();
  }, [viewedJob?.id, viewedJob?.resultsRevision, activeId, selectedId, routeRetry]);
  const copySettings = (job: JobSnapshot) => {
    viewOperation.current?.abort();
    setPendingJob(null);
    const query = job.query;
    setRegions([...query.sections]);
    setDistance(
      query.distance.map((value) => inputUnits(value, MILE)) as [
        string,
        string,
      ],
    );
    setGain(
      query.gain.map((value) => inputUnits(value, FOOT)) as [string, string],
    );
    setRepetition(String(query.repetition * 100));
    const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
    setRoadMiles(inputUnits(roads.distance, MILE));
    setRoadPercent(String(roads.fraction * 100));
    setIncludeUnknown(query.includeUnknown);
    setShowSearchArea(true);
    setJobsOpen(false);
    setSearchCollapsed(false);
    clearSelection();
    setError("");
    const sections = dataset?.sections.filter((section) =>
      query.sections.includes(section.id),
    );
    if (sections?.length) moveTo(regionBounds(sections));
  };
  const mutateJob = async (job: JobSnapshot, action: "cancel" | "delete") => {
    const controller = new AbortController();
    setPendingJob({ id: job.id, action });
    setJobActionError("");
    try {
      await request(
        `/api/jobs/${encodeURIComponent(job.id)}${action === "delete" ? "" : `/${action}`}`,
        controller.signal,
        action === "delete" ? undefined : {},
        action === "delete" ? "DELETE" : undefined,
      );
      if (action === "delete") jobHistory.remove(job.id);
      else jobHistory.upsert(await request<JobSnapshot>(`/api/jobs/${encodeURIComponent(job.id)}?inputs=false`, controller.signal));
      if (action === "delete" && viewedJob?.id === job.id) {
        closeResults();
      }
    } catch (failure) {
      setJobActionError(
        failure instanceof Error ? failure.message : "The job action failed.",
      );
    } finally {
      setPendingJob(null);
    }
  };
  const chooseRegions = (ids: string[]) => {
    if (busy || downloading || choosingDownload) return;
    setShowSearchArea(true);
    setRegions(ids);
    setError("");
    const sections = dataset?.sections.filter((section) =>
      ids.includes(section.id),
    );
    if (sections?.length) moveTo(regionBounds(sections));
  };
  const beginSearch = async (query: SearchQuery) => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      const job = await request<JobSnapshot>(
        "/api/jobs",
        controller.signal,
        query,
      );
      if (controller.signal.aborted) return;
      jobHistory.upsert(job);
      setHighlightedJob(job.id);
      setSettingsOpen(false);
      setJobsOpen(true);
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejection = failure as Error & {
          status?: number;
          sections?: string[];
          bytes?: number;
        };
        if (rejection.status === 409 && Array.isArray(rejection.sections))
          setPendingDownload({
            query,
            coverage: {
              sections: rejection.sections,
              missing: rejection.sections,
              bytes: rejection.bytes ?? 0,
            },
          });
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Job could not be submitted.",
          );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const launch = async (event: FormEvent) => {
    event.preventDefault();
    if (!regions.length || busy || downloading || pendingDownload) return;
    const distances = distance.map(Number),
      gains = gain.map(Number),
      repeated = Number(repetition);
    const roadDistance = Number(roadMiles),
      roadFraction = Number(roadPercent);
    if (
      [...distances, ...gains, repeated, roadDistance, roadFraction].some(
        (value) => !Number.isFinite(value) || value < 0,
      ) ||
      !distances[1] ||
      distances[0]! > distances[1]! ||
      gains[0]! > gains[1]! ||
      repeated > 100 ||
      roadFraction > 100 ||
      !roadMiles ||
      !roadPercent
    ) {
      setError(
        "Use a positive maximum distance and ranges whose minimum is no greater than their maximum. Percentages must be 0–100%, and road mileage zero or greater.",
      );
      return;
    }
    const query: SearchQuery = {
      sections: [...regions],
      distance: [distances[0]! * MILE, distances[1]! * MILE],
      gain: [gains[0]! * FOOT, gains[1]! * FOOT],
      repetition: repeated / 100,
      includeUnknown,
      effort: "deep",
      roads: { distance: roadDistance * MILE, fraction: roadFraction / 100 },
    };
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      const coverage = await request<Coverage>(
        "/api/coverage",
        controller.signal,
        query,
      );
      if (controller.signal.aborted) return;
      if (coverage.missing.length) {
        setDownload(null);
        setPendingDownload({ query, coverage });
      } else await beginSearch(query);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not check trail coverage.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const finishDownload = async (
    snapshot: DownloadSnapshot,
    signal: AbortSignal,
  ) => {
    const info = await request<CatalogView>("/api/catalog", signal);
    if (signal.aborted) return;
    setDataset(info);
    setDownload(snapshot);
    const waitingQuery = downloadQuery.current;
    downloadQuery.current = null;
    if (waitingQuery) {
      if (snapshot.status === "complete") await beginSearch(waitingQuery);
      else
        setError(
          snapshot.reason ||
            "Download stopped. Submit the search to try again.",
        );
    }
  };
  const beginDownload = async (
    sections: string[],
    query: SearchQuery | null = null,
  ) => {
    if (busy || downloading) return;
    const controller = new AbortController();
    operation.current = controller;
    downloadQuery.current = query;
    setBusy(true);
    setError("");
    setDownloadError("");
    try {
      const snapshot = await request<DownloadSnapshot>(
        "/api/downloads",
        controller.signal,
        { sections },
      );
      if (controller.signal.aborted) return;
      setPendingDownload(null);
      if (snapshot.status === "running") setDownload(snapshot);
      else await finishDownload(snapshot, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) {
        downloadQuery.current = null;
        setError(
          failure instanceof Error
            ? failure.message
            : "Download could not start.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const stopDownload = async () => {
    downloadQuery.current = null;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      await finishDownload(
        await request<DownloadSnapshot>(
          "/api/downloads/stop",
          controller.signal,
          {},
        ),
        controller.signal,
      );
    } catch (failure) {
      setDownloadError(
        failure instanceof Error
          ? failure.message
          : "Could not stop the download.",
      );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<DownloadSnapshot | null>(
          "/api/downloads",
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setDownloadError("");
        if (!next) {
          setDownload(null);
          downloadQuery.current = null;
          setError("The download stopped. Try submitting your search again.");
          return;
        }
        if (next.status !== "running") {
          await finishDownload(next, controller.signal);
          return;
        }
        setDownload(next);
      } catch (failure) {
        if (!controller.signal.aborted)
          setDownloadError(
            failure instanceof Error
              ? failure.message
              : "Download connection lost.",
          );
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 750);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [downloading, downloadRetry]);
  useEffect(() => {
    if (!pendingDownload) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    downloadDialog.current?.showModal();
    return () => {
      downloadDialog.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [pendingDownload]);
  const pickRoute = (id: string) => {
    setResultsCollapsed(false);
    setShowSearchArea(false);
    setHoveredId(null);
    if (id === selectedId) {
      if (!selected) setRouteRetry((value) => value + 1);
      return;
    }
    focusedRouteId.current = null;
    setSelected(null);
    setSelectedId(id);
  };
  const readyCount = jobs.filter(
    (job) =>
      hasSavedResults(job) &&
      viewedRevisions.current.get(job.id) !== (job.resultsRevision ?? 0),
  ).length;
  const currentJob = jobs.find((job) => job.id === highlightedJob);
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>
          <span className="brand-mark" aria-hidden="true">
            △
          </span>{" "}
          Alpine Loop
        </h1>
        <nav aria-label="App">
          <button
            id="open-settings"
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
            {downloading && (
              <span className="header-count" aria-label="Download running">
                ↓
              </span>
            )}
          </button>
          <button
            id="open-search-jobs"
            type="button"
            className="jobs-button"
            onClick={() => setJobsOpen(true)}
          >
            Jobs
            {readyCount ? (
              <span className="header-count">{readyCount} ready</span>
            ) : jobs.some(activeJob) ? (
              <span className="header-count">Running</span>
            ) : null}
          </button>
        </nav>
      </header>
      <main
        className={`workspace${searchCollapsed ? " is-collapsed" : ""}${resultsCollapsed || !viewedJob ? " is-results-collapsed" : ""}`}
      >
        <aside
          id="search-panel"
          className="sidebar"
          aria-label="Search"
          hidden={searchCollapsed}
        >
          <div className="sidebar-content">
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {(jobActionError || jobHistory.error) && !jobsOpen && (
              <div className="error-banner" role="alert">
                {jobActionError || jobHistory.error}
                <button
                  type="button"
                  onClick={jobHistory.refresh}
                >
                  Reconnect
                </button>
              </div>
            )}
            {!dataset && (
              <div className="startup" role={startupError ? "alert" : "status"}>
                {startupError || "Opening trail data…"}
              </div>
            )}
            {dataset && (
              <form
                className="planner"
                onSubmit={(event) => void launch(event)}
              >
                <fieldset
                  className="planner-fields"
                  disabled={busy || downloading || choosingDownload}
                >
                  <h2 className="planner-title">Search</h2>
                  <label className="field-label" id="search-region-label">
                    Region
                  </label>
                  <RegionPicker
                    dataset={dataset}
                    value={regions}
                    disabled={busy || downloading || choosingDownload}
                    onChange={chooseRegions}
                  />
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
                    <span>Repeated trail, max</span>
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
                  <details
                    className="more-options"
                    onInvalidCapture={(event) => {
                      event.currentTarget.open = true;
                    }}
                  >
                    <summary>More options</summary>
                    <div className="road-inputs">
                      <label htmlFor="road-miles">
                        Roads, max miles
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
                        Roads, max %
                        <input
                          id="road-percent"
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          required
                          value={roadPercent}
                          onChange={(event) =>
                            setRoadPercent(event.target.value)
                          }
                        />
                      </label>
                    </div>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={includeUnknown}
                        onChange={(event) =>
                          setIncludeUnknown(event.target.checked)
                        }
                      />
                      Include uncertain access
                    </label>
                  </details>
                  <button
                    className="primary search-button"
                    type="submit"
                    disabled={busy || !regions.length}
                  >
                    {busy ? "Submitting…" : "Search"}
                  </button>
                </fieldset>
              </form>
            )}
            {downloading && (
              <section
                className="workspace-status"
                aria-label="Download progress"
              >
                <div>
                  <strong>Downloading</strong>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSettingsOpen(true)}
                  >
                    Details
                  </button>
                </div>
                <progress
                  aria-label="Trail download progress"
                  value={Math.min(download.completedBytes, download.totalBytes)}
                  max={Math.max(1, download.totalBytes)}
                />
                <p>
                  {storage(download.completedBytes)} /{" "}
                  {storage(download.totalBytes)}
                </p>
                {downloadError && <p role="alert">{downloadError}</p>}
              </section>
            )}
            {currentJob && (
              <section className="workspace-status" aria-label="Latest search">
                <div>
                  <strong>
                    {currentJob.status === "completed"
                      ? "Results ready"
                      : currentJob.status === "queued"
                        ? `Queued · ${currentJob.queuePosition ?? "—"}`
                        : currentJob.status === "running"
                          ? currentJob.progress.stage === "saving"
                            ? "Saving"
                            : "Searching"
                          : currentJob.status[0]!.toUpperCase() +
                            currentJob.status.slice(1)}
                  </strong>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!pendingJob}
                    onClick={() =>
                      hasSavedResults(currentJob)
                        ? void openResults(currentJob)
                        : setJobsOpen(true)
                    }
                  >
                    {hasSavedResults(currentJob) ? "View results" : "Details"}
                  </button>
                </div>
                {currentJob.status === "running" && (
                  <>
                    <progress
                      aria-label="Within-region search progress"
                      max={currentJob.progress.totalSearchPoints || undefined}
                      value={
                        currentJob.progress.totalSearchPoints
                          ? (currentJob.progress.completedSearchPoints ?? 0)
                          : undefined
                      }
                    />
                    <p>
                      {elapsed(currentJob.progress.elapsedMs)} ·{" "}
                      {currentJob.progress.completedRegions.length} /{" "}
                      {currentJob.progress.totalRegions} regions
                    </p>
                  </>
                )}
              </section>
            )}
          </div>
        </aside>
        <button
          className="collapse-search"
          type="button"
          aria-controls="search-panel"
          aria-label={
            searchCollapsed ? "Expand search panel" : "Collapse search panel"
          }
          aria-expanded={!searchCollapsed}
          onClick={() => setSearchCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{searchCollapsed ? "›" : "‹"}</span>
        </button>
        <section className="browser-panel" aria-label="Browse hikes">
          {mapDataset && camera ? (
            <Suspense
              fallback={
                <div className="map-placeholder" aria-label="Loading map" />
              }
            >
              <HikeMap
                sections={mapDataset.sections}
                selectedSections={
                  showSearchArea
                    ? regions
                    : (viewedJob?.query.sections ?? regions)
                }
                routes={locations}
                profileCursor={profileCursor}
                activeRoute={activeRoute}
                selectedId={selectedId}
                selectedGroupId={selected?.groupId}
                selectedLocationIds={
                  !selectedId && typeof resultScope !== "string"
                    ? resultScope
                    : undefined
                }
                routeNotice={
                  activeId
                    ? routeError || (!activeRoute ? "Loading route…" : "")
                    : ""
                }
                onRetryRoute={
                  routeError
                    ? () => setRouteRetry((value) => value + 1)
                    : undefined
                }
                camera={camera}
                onSelect={(id) => {
                  if (
                    typeof resultScope !== "string" &&
                    !resultScope.has(id) &&
                    id !== selectedId
                  )
                    setResultScope("view");
                  pickRoute(id);
                }}
                onPreview={setHoveredId}
                onBoundsChange={(bounds, userMoved) => {
                  setMapBounds((current) =>
                    current?.every((value, index) => value === bounds[index])
                      ? current
                      : bounds,
                  );
                  if (userMoved)
                    setResultScope((current) =>
                      typeof current === "string" ? current : "view",
                    );
                }}
                onBrowse={(ids) => {
                  clearSelection();
                  setResultsCollapsed(false);
                  setResultScope(new Set(ids));
                  requestAnimationFrame(() =>
                    document.getElementById("results-heading")?.focus(),
                  );
                }}
              />
            </Suspense>
          ) : (
            <div className="map-placeholder" />
          )}
        </section>
        {viewedJob && (
          <button
            className="collapse-results"
            type="button"
            aria-controls="results-panel"
            aria-label={
              resultsCollapsed
                ? "Expand results panel"
                : "Collapse results panel"
            }
            aria-expanded={!resultsCollapsed}
            onClick={() => setResultsCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{resultsCollapsed ? "‹" : "›"}</span>
          </button>
        )}
        {viewedJob && (
          <aside
            id="results-panel"
            className="results-panel"
            aria-label="Hike results"
            hidden={resultsCollapsed}
          >
            <header className="results-header">
              <div>
                <h2 id="results-heading" tabIndex={-1}>
                  Results
                </h2>
                {viewedJob && (
                  <div className="results-actions">
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => copySettings(viewedJob)}
                    >
                      Copy settings
                    </button>
                    <button
                      type="button"
                      className="close-results"
                      aria-label="Close results"
                      onClick={closeResults}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              {viewedJob && <p>{requestSummary(viewedJob.query)}</p>}
            </header>
            {viewedJob && selectedId ? (
              <div className="route-inspector" aria-label="Selected hike">
                {selectedId &&
                  (selected ? (
                    <RouteDetails
                      route={selected}
                      jobId={viewedJob.id}
                      resultsRevision={viewedJob.resultsRevision ?? 0}
                      onBack={clearSelection}
                      onProfileHover={profileCursor.set}
                    />
                  ) : (
                    <div className="route-loading">
                      <button
                        type="button"
                        className="text-button"
                        onClick={clearSelection}
                      >
                        ← Hikes
                      </button>
                      <p role={routeError ? "alert" : "status"}>
                        {routeError || "Loading hike details…"}
                      </p>
                      {routeError && (
                        <button
                          type="button"
                          onClick={() => setRouteRetry((value) => value + 1)}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            ) : (
              <>
                {viewedJob && (
                  <div className="results-filter">
                    <div
                      className="view-toggle"
                      role="group"
                      aria-label="Result scope"
                    >
                      <button
                        type="button"
                        aria-pressed={resultScope === "view"}
                        title="Hikes with a starting point in the map view"
                        onClick={() => setResultScope("view")}
                      >
                        In view
                      </button>
                      <button
                        type="button"
                        aria-pressed={resultScope === "all"}
                        title="All hikes in this search"
                        onClick={() => setResultScope("all")}
                      >
                        All
                      </button>
                    </div>
                    <span role="status">
                      {visibleLocations.length.toLocaleString()}
                      {resultScope === "view" &&
                        ` / ${locations.length.toLocaleString()}`}{" "}
                      hikes{typeof resultScope !== "string" && " at marker"}
                    </span>
                  </div>
                )}
                <div className="results-list">
                  <FixedList items={visibleLocations} rowHeight={70}>
                    {(route, index) => (
                      <li key={route.id} aria-posinset={index + 1} aria-setsize={visibleLocations.length}>
                        <button
                          type="button"
                          data-row={index}
                          onPointerEnter={() => setHoveredId(route.id)}
                          onPointerLeave={() => setHoveredId(null)}
                          onFocus={() => setHoveredId(route.id)}
                          onBlur={() => setHoveredId(null)}
                          onClick={() => pickRoute(route.id)}
                        >
                          <strong>{route.trailNames.slice(0, 2).join(" / ") || route.startName || "Unnamed trails"}</strong>
                          <span>{miles(route.distance)} mi · {route.startName || "Unnamed start"}</span>
                        </button>
                      </li>
                    )}
                  </FixedList>
                  {!visibleLocations.length && (
                    <p className="empty-state">
                      {!locations.length
                        ? "No hikes found."
                        : !mapBounds && resultScope === "view"
                          ? "Loading map…"
                          : "No hikes in view."}
                    </p>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </main>
      <SettingsDialog
        open={settingsOpen}
        dataset={dataset}
        download={download}
        downloadError={downloadError}
        busy={busy || choosingDownload}
        onClose={() => setSettingsOpen(false)}
        onDownload={(ids) => void beginDownload(ids)}
        onStopDownload={() => void stopDownload()}
        onRetryDownload={() => setDownloadRetry((value) => value + 1)}
        onDismissDownload={() => setDownload(null)}
      />
      <dialog
        ref={downloadDialog}
        className="download-modal"
        aria-labelledby="download-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setPendingDownload(null);
        }}
      >
        {pendingDownload && (
          <>
            <header className="dialog-heading">
              <h2 id="download-title">Download trail data?</h2>
            </header>
            <div className="dialog-body">
              <p className="download-total">
                {storage(pendingDownload.coverage.bytes)}
              </p>
              <ul className="download-names">
                {pendingDownload.coverage.missing.map((id) => (
                  <li key={id}>{regionName(id)}</li>
                ))}
              </ul>
              <div className="download-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void beginDownload(
                      pendingDownload.coverage.missing,
                      pendingDownload.query,
                    )
                  }
                >
                  Download and search
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingDownload(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
      </dialog>
      {jobsOpen && (
        <JobsDialog
          open={jobsOpen}
          jobs={jobHistory.history}
          regionName={regionName}
          highlightedId={highlightedJob}
          error={jobActionError || jobHistory.error}
          pending={pendingJob}
          onClose={() => setJobsOpen(false)}
          onRefresh={jobHistory.refresh}
          loading={jobHistory.loading}
          hasOlder={jobHistory.hasOlder}
          hasNewer={jobHistory.hasNewer}
          onOlder={jobHistory.older}
          onNewer={jobHistory.newer}
          onView={(job) => void openResults(job)}
          onCopy={copySettings}
          onAction={(job, action) => void mutateJob(job, action)}
        />
      )}
    </div>
  );
}
