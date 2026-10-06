import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Bounds,
  HikeRoute,
  RouteChoice,
  RouteSummary,
  RouteView,
  SearchQuery,
  JobSnapshot,
  JobResults,
  RouteLocation,
  ResultSort,
  SortOrder,
} from "../model.js";
import { DEFAULT_ROAD_LIMITS, ROUTES_PER_PAGE } from "../model.js";
import type {
  CatalogView,
  Coverage,
  DownloadSnapshot,
} from "../data-format.js";
import { HikeMap } from "./Map.js";
import {
  JobsDialog,
  activeJob,
  hasSavedResults,
  requestSummary,
  savedResultsURL,
} from "./JobsDialog.js";

const MILE = 1609.344;
const FOOT = 0.3048;
const miles = (meters: number) => (meters / MILE).toFixed(1);
const feet = (meters: number) => Math.round(meters / FOOT).toLocaleString();
const megabytes = (bytes: number) =>
  `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
const roadExplanation =
  "Includes roads, forest vehicle tracks and sidewalk connections, based on mapped classification. Return walks count too.";
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
async function request<T>(
  url: string,
  signal: AbortSignal,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    ...(method ? { method } : {}),
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
          ? "This saved job or route is no longer available."
          : typeof data?.error === "string"
            ? data.error
            : (data?.message ??
              data?.error?.message ??
              "The server could not complete this request."),
      ),
      {
        status: response.status,
        sections: data?.missing ?? data?.sections,
        bytes: data?.bytes,
      },
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
  jobId,
  resultsRevision,
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
  jobId: string;
  resultsRevision: number;
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
      <button
        type="button"
        className="text-button"
        onClick={onBack}
        disabled={backDisabled}
      >
        ← All hikes
      </button>
      <h2 id="route-detail-heading" tabIndex={-1}>
        {routeName(route)}
      </h2>
      {reversing ? (
        <div
          className="direction-status"
          role={directionError ? "alert" : "status"}
        >
          <p>{directionError || "Loading the other direction…"}</p>
          {directionError && (
            <button type="button" onClick={onRetry}>
              Retry direction
            </button>
          )}
        </div>
      ) : (
        <>
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
          {(route.reverseId || route.oppositeId) && (
            <button
              type="button"
              className="text-button reverse-direction"
              onClick={onReverse}
            >
              {reversed ? "Use original direction" : route.reverseId ? "Reverse direction" : "Other loop direction"}
            </button>
          )}
          {reversed && (
            <p className="field-hint" role="status">
              Other direction selected. GPX follows this route.
            </p>
          )}
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
              {(route.roadDistance / MILE).toFixed(2)} mi (
              {((100 * route.roadDistance) / route.distance).toFixed(1)}%)
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
            href={savedResultsURL({ id: jobId, resultsRevision }, `routes/${encodeURIComponent(route.id)}.gpx`)}
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
        </>
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
const resultQuery = (
  offset: number,
  sort: ResultSort,
  order: SortOrder,
  group?: string,
) =>
  `?offset=${offset}&sort=${sort}&order=${order}${group ? `&group=${encodeURIComponent(group)}` : ""}`;

export function App() {
  const [dataset, setDataset] = useState<CatalogView>();
  const [startupError, setStartupError] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [editing, setEditing] = useState(true);
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
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [highlightedJob, setHighlightedJob] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState("");
  const [jobActionError, setJobActionError] = useState("");
  const [jobsRetry, setJobsRetry] = useState(0);
  const [pendingJob, setPendingJob] = useState<{
    id: string;
    action: string;
  } | null>(null);
  const [viewedJob, setViewedJob] = useState<JobSnapshot>();
  const [results, setResults] = useState<JobResults>();
  const [locations, setLocations] = useState<RouteLocation[]>([]);
  const [sort, setSort] = useState<ResultSort>("distance");
  const [order, setOrder] = useState<SortOrder>("asc");
  const [loadingPage, setLoadingPage] = useState(false);
  const [selected, setSelected] = useState<RouteChoice | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<RouteView | null>(null);
  const [routeError, setRouteError] = useState("");
  const [routeRetry, setRouteRetry] = useState(0);
  const originalDirectionId = useRef<string | null>(null);
  const [showStarts, setShowStarts] = useState(false);
  const [starts, setStarts] = useState<JobResults>();
  const [loadingStarts, setLoadingStarts] = useState(false);
  const [startsError, setStartsError] = useState("");
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
  const pageOperation = useRef<AbortController | null>(null);
  const startsOperation = useRef<AbortController | null>(null);
  const viewedRevisions = useRef(new Map<string, number>());
  const initialJobId = useRef(
    new URLSearchParams(window.location.search).get("job"),
  );
  const downloading = download?.status === "running";
  const choosingDownload = !!pendingDownload;
  const activeId = editing ? null : (selectedId ?? hoveredId);
  const activeRoute = geometry?.id === activeId ? geometry : null;
  const mapDataset =
    !editing && viewedJob ? (savedMap(viewedJob) ?? dataset) : dataset;
  const regionName = (id: string) =>
    dataset?.sections.find((section) => section.id === id)?.name ?? id;
  const moveTo = (bounds: Bounds, padding = 40) =>
    setCamera((current) => ({
      bounds,
      revision: (current?.revision ?? 0) + 1,
      padding,
    }));
  const clearSelection = () => {
    startsOperation.current?.abort();
    setLoadingStarts(false);
    setSelected(null);
    setSelectedId(null);
    setHoveredId(null);
    setShowStarts(false);
    setStarts(undefined);
    setStartsError("");
  };
  const localURL = (id?: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("job", id);
    else url.searchParams.delete("job");
    window.history.replaceState(null, "", url);
  };
  const openResults = async (job: JobSnapshot) => {
    if (!hasSavedResults(job)) {
      setJobsOpen(true);
      setHighlightedJob(job.id);
      return;
    }
    pageOperation.current?.abort();
    const controller = new AbortController();
    pageOperation.current = controller;
    setPendingJob({ id: job.id, action: "open" });
    setError("");
    setJobActionError("");
    try {
      const fullJob = await request<JobSnapshot>(
        `/api/jobs/${encodeURIComponent(job.id)}`,
        controller.signal,
      );
      const [page, positions] = await Promise.all([
        request<JobResults>(
          savedResultsURL(fullJob, "results", resultQuery(0, "distance", "asc")),
          controller.signal,
        ),
        request<RouteLocation[]>(
          savedResultsURL(fullJob, "locations"),
          controller.signal,
        ),
      ]);
      if (controller.signal.aborted) return;
      setViewedJob(fullJob);
      setResults(page);
      setLocations(positions);
      setSort("distance");
      setOrder("asc");
      clearSelection();
      setEditing(false);
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
      pageOperation.current?.abort();
      startsOperation.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<JobSnapshot[]>(
          "/api/jobs",
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setJobs(next);
        setJobsError("");
        const id = initialJobId.current;
        if (id) {
          initialJobId.current = null;
          const job = next.find((item) => item.id === id);
          if (job) void openResults(job);
          else {
            setError("This saved job has been deleted.");
            localURL();
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setJobsError(
            failure instanceof Error
              ? failure.message
              : "Jobs could not reconnect.",
          );
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobsRetry]);
  useEffect(() => {
    if (!activeId || !viewedJob) {
      setGeometry(null);
      return;
    }
    const controller = new AbortController();
    setRouteError("");
    setGeometry(null);
    void request<RouteView>(
      savedResultsURL(viewedJob, `routes/${encodeURIComponent(activeId)}`),
      controller.signal,
    )
      .then((route) => {
        if (controller.signal.aborted) return;
        setGeometry(route);
        if (selectedId === route.id) {
          setSelected(route);
          moveTo(routeBounds(route));
          requestAnimationFrame(() =>
            document.getElementById("route-detail-heading")?.focus(),
          );
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setRouteError(
            failure instanceof Error
              ? failure.message
              : "Route drawing could not load.",
          );
      });
    return () => controller.abort();
  }, [viewedJob?.id, viewedJob?.resultsRevision, activeId, selectedId, routeRetry]);
  const changePage = async (
    offset: number,
    nextSort = sort,
    nextOrder = order,
  ) => {
    if (!viewedJob) return;
    pageOperation.current?.abort();
    const controller = new AbortController();
    pageOperation.current = controller;
    setLoadingPage(true);
    setError("");
    clearSelection();
    try {
      const page = await request<JobResults>(
        savedResultsURL(viewedJob, "results", resultQuery(offset, nextSort, nextOrder)),
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setResults(page);
        setSort(nextSort);
        setOrder(nextOrder);
        requestAnimationFrame(() =>
          document.getElementById("page-summary")?.focus(),
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Results page could not load.",
        );
    } finally {
      if (!controller.signal.aborted) setLoadingPage(false);
    }
  };
  const copySettings = (job: JobSnapshot) => {
    pageOperation.current?.abort();
    setPendingJob(null);
    const query = job.query;
    setRegions([...query.sections]);
    setDistance(
      query.distance.map((value) => String(value / MILE)) as [string, string],
    );
    setGain(
      query.gain.map((value) => String(value / FOOT)) as [string, string],
    );
    setRepetition(String(query.repetition * 100));
    const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
    setRoadMiles(String(roads.distance / MILE));
    setRoadPercent(String(roads.fraction * 100));
    setIncludeUnknown(query.includeUnknown);
    setEditing(true);
    setJobsOpen(false);
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
      const next = await request<JobSnapshot[]>("/api/jobs", controller.signal);
      setJobs(next);
      if (action === "delete" && viewedJob?.id === job.id) {
        setViewedJob(undefined);
        setResults(undefined);
        setLocations([]);
        setEditing(true);
        clearSelection();
        localURL();
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
    if (!editing || busy || downloading || choosingDownload) return;
    setRegions(ids);
    setError("");
    const sections = dataset?.sections.filter((section) =>
      ids.includes(section.id),
    );
    if (sections?.length) moveTo(regionBounds(sections));
  };
  const toggleRegion = (id: string) =>
    chooseRegions(
      regions.includes(id)
        ? regions.filter((region) => region !== id)
        : [...regions, id],
    );
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
      setJobs((current) => [
        job,
        ...current.filter((item) => item.id !== job.id),
      ]);
      setHighlightedJob(job.id);
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
    const query = snapshot.status === "complete" ? downloadQuery.current : null;
    downloadQuery.current = null;
    if (query) await beginSearch(query);
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
    if (pendingDownload) document.getElementById("confirm-download")?.focus();
  }, [pendingDownload]);
  const pickRoute = (id: string) => {
    startsOperation.current?.abort();
    setLoadingStarts(false);
    setSelected(
      results?.routes.find((route) => route.id === id) ??
        starts?.routes.find((route) => route.id === id) ??
        null,
    );
    setSelectedId(id);
    setHoveredId(null);
    originalDirectionId.current = id;
    setShowStarts(false);
    setStarts(undefined);
  };
  const loadStarts = async (offset = 0) => {
    if (!selected || !viewedJob) return;
    startsOperation.current?.abort();
    const controller = new AbortController();
    startsOperation.current = controller;
    const groupId = selected.groupId;
    setShowStarts(true);
    setLoadingStarts(true);
    setStartsError("");
    try {
      const page = await request<JobResults>(
        savedResultsURL(viewedJob, "results", resultQuery(offset, "distance", "asc", groupId)),
        controller.signal,
      );
      if (!controller.signal.aborted && startsOperation.current === controller)
        setStarts(page);
    } catch (failure) {
      if (!controller.signal.aborted && startsOperation.current === controller)
        setStartsError(
          failure instanceof Error
            ? failure.message
            : "Starting points could not load.",
        );
    } finally {
      if (!controller.signal.aborted && startsOperation.current === controller)
        setLoadingStarts(false);
    }
  };
  const pages = (
    page: JobResults,
    onPage: (offset: number) => void,
    isStarts = false,
  ) =>
    page.pageTotal > ROUTES_PER_PAGE ? (
      <nav
        className="result-pages"
        aria-label={isStarts ? "Starting point pages" : "Hike pages"}
      >
        <button
          type="button"
          disabled={loadingPage || loadingStarts || page.offset === 0}
          onClick={() => onPage(Math.max(0, page.offset - ROUTES_PER_PAGE))}
        >
          Previous
        </button>
        <span
          id={isStarts ? "starts-page-summary" : "page-summary"}
          tabIndex={-1}
        >
          {page.offset + 1}–{page.offset + page.routes.length} of{" "}
          {page.pageTotal.toLocaleString()}
        </span>
        <button
          type="button"
          disabled={
            loadingPage ||
            loadingStarts ||
            page.offset + ROUTES_PER_PAGE >= page.pageTotal
          }
          onClick={() => onPage(page.offset + ROUTES_PER_PAGE)}
        >
          Next
        </button>
      </nav>
    ) : null;
  const readyCount = jobs.filter(
    (job) => hasSavedResults(job) && viewedRevisions.current.get(job.id) !== (job.resultsRevision ?? 0),
  ).length;
  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="Route planner">
        <header className="app-label">
          <h1>Alpine Loop</h1>
          <button
            type="button"
            id="open-search-jobs"
            className="jobs-button"
            onClick={() => {
              setHighlightedJob(null);
              setJobsOpen(true);
            }}
          >
            Jobs
            {readyCount ? (
              <span className="ready-indicator">{readyCount} ready</span>
            ) : jobs.some(activeJob) ? (
              <span className="active-indicator">Running</span>
            ) : null}
          </button>
        </header>
        <div className="sidebar-content">
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {(jobActionError || jobsError) && !jobsOpen && (
            <div className="error-banner" role="alert">
              {jobActionError || jobsError}
              <button
                type="button"
                onClick={() => setJobsRetry((value) => value + 1)}
              >
                Reconnect jobs
              </button>
            </div>
          )}
          {editing && !dataset && (
            <div className="startup" role={startupError ? "alert" : "status"}>
              <p>{startupError || "Opening trail data…"}</p>
              {startupError && <p>Saved jobs are still available from Jobs.</p>}
            </div>
          )}
          {pendingDownload && dataset && (
            <section
              className="download-panel"
              aria-labelledby="download-heading"
            >
              <h2 id="download-heading">Download trails for this search</h2>
              <p>
                {megabytes(pendingDownload.coverage.bytes)} total. Downloaded
                sections stay on this computer.
              </p>
              <ul>
                {pendingDownload.coverage.missing.map((id) => (
                  <li key={id}>{regionName(id)}</li>
                ))}
              </ul>
              <div className="download-actions">
                <button
                  id="confirm-download"
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
                  Download and submit job
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingDownload(null)}
                >
                  Cancel
                </button>
              </div>
            </section>
          )}
          {download && (
            <section className="download-panel" aria-label="Trail download">
              <h2>
                {downloading
                  ? "Downloading trail sections"
                  : download.status === "complete"
                    ? "Trail sections ready"
                    : download.status === "stopped"
                      ? "Download stopped"
                      : "Download failed"}
              </h2>
              <p>{download.sections.map(regionName).join(" · ")}</p>
              {downloading && (
                <progress
                  aria-label="Trail download progress"
                  value={Math.min(download.completedBytes, download.totalBytes)}
                  max={Math.max(1, download.totalBytes)}
                />
              )}
              <p>
                {megabytes(download.completedBytes)} of{" "}
                {megabytes(download.totalBytes)}
                {downloading && downloadQuery.current
                  ? ". Your job is submitted when the download finishes."
                  : ""}
              </p>
              {download.reason && <p>{download.reason}</p>}
              {downloadError && <p role="alert">{downloadError}</p>}
              <div className="download-actions">
                {downloading ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void stopDownload()}
                    >
                      Cancel download
                    </button>
                    {downloadError && (
                      <button
                        type="button"
                        onClick={() => setDownloadRetry((value) => value + 1)}
                      >
                        Reconnect
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" onClick={() => setDownload(null)}>
                    Dismiss
                  </button>
                )}
              </div>
            </section>
          )}
          {editing && dataset ? (
            <form className="planner" onSubmit={(event) => void launch(event)}>
              <fieldset
                className="planner-fields"
                disabled={busy || downloading || choosingDownload}
              >
                <div className="section-heading">
                  <h2>Search regions</h2>
                  {viewedJob && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setEditing(false);
                      }}
                    >
                      Back to results
                    </button>
                  )}
                </div>
                <p className="region-description">
                  Choose one or more prepared regions. Routes stay within their
                  mountain and highway boundaries.
                </p>
                <div className="region-list-heading">
                  <span>
                    {regions.length
                      ? `${regions.length} selected`
                      : "No regions selected"}
                  </span>
                  {dataset.sections.length > 1 && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() =>
                        chooseRegions(
                          regions.length === dataset.sections.length
                            ? []
                            : dataset.sections.map((section) => section.id),
                        )
                      }
                    >
                      {regions.length === dataset.sections.length
                        ? "Clear selection"
                        : "Select all"}
                    </button>
                  )}
                </div>
                <ul className="regions-list" aria-label="Search regions">
                  {dataset.sections.map((section) => (
                    <li
                      key={section.id}
                      className={
                        regions.includes(section.id) ? "is-selected" : undefined
                      }
                    >
                      <label>
                        <input
                          type="checkbox"
                          aria-label={section.name}
                          checked={regions.includes(section.id)}
                          onChange={() => toggleRegion(section.id)}
                        />
                        <span>
                          <strong>{section.name}</strong>
                          <small>
                            {section.installed
                              ? "Downloaded · "
                              : section.needsRepair
                                ? "Needs repair · "
                                : "Download available · "}
                            {megabytes(section.bytes)}
                          </small>
                        </span>
                      </label>
                      {!section.installed && (
                        <button
                          type="button"
                          aria-label={`Download ${section.name}`}
                          onClick={() => void beginDownload([section.id])}
                        >
                          Download
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {!dataset.sections.length && (
                  <p className="region-description">
                    No prepared regions are available yet.
                  </p>
                )}
                {!!dataset.unavailable?.length && (
                  <ul className="unavailable-regions">
                    {dataset.unavailable.map((region) => (
                      <li key={region.name}>
                        <strong>{region.name}</strong>
                        <span>{region.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
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
                  <p className="field-hint">
                    Both limits apply. {roadExplanation}
                  </p>
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
                  disabled={busy || !regions.length}
                >
                  {busy ? "Submitting…" : "Submit search job"}
                </button>
                <p className="field-hint">
                  Results are ready when the job finishes. You can submit
                  another job while one runs.
                </p>
              </fieldset>
            </form>
          ) : !editing && viewedJob && results ? (
            <>
              <section className="search-summary" aria-label="Saved search">
                <div className="section-heading">
                  <h2>Search results</h2>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => copySettings(viewedJob)}
                  >
                    Copy settings
                  </button>
                </div>
                <p className="current-regions">
                  {viewedJob.query.sections
                    .map(
                      (id) =>
                        viewedJob.inputs?.sections.find(
                          (section) => section.id === id,
                        )?.name ?? regionName(id),
                    )
                    .join(" · ")}
                </p>
                <p className="query-summary">
                  {requestSummary(viewedJob.query)}
                </p>
                <p className="access-summary">
                  {viewedJob.query.includeUnknown
                    ? "Uncertain access included"
                    : "Mapped public access only"}{" "}
                  · Search completed
                </p>
              </section>
              <section
                className="results"
                aria-label="Completed search results"
                aria-busy={loadingPage}
              >
                <h2 className="results-heading">
                  {results.groupCount.toLocaleString()}{" "}
                  {results.groupCount === 1 ? "hike" : "hikes"} found
                </h2>
                {!selectedId && (
                  <>
                    <div className="result-sort">
                      <label htmlFor="sort-by">Sort by</label>
                      <select
                        id="sort-by"
                        value={sort}
                        disabled={loadingPage}
                        onChange={(event) =>
                          void changePage(
                            0,
                            event.target.value as ResultSort,
                            order,
                          )
                        }
                      >
                        <option value="distance">Distance</option>
                        <option value="gain">Climb</option>
                        <option value="repetition">Walked again</option>
                        <option value="roadDistance">Road distance</option>
                      </select>
                      <button
                        type="button"
                        disabled={loadingPage}
                        onClick={() =>
                          void changePage(
                            0,
                            sort,
                            order === "asc" ? "desc" : "asc",
                          )
                        }
                        aria-label={`Sort ${order === "asc" ? "descending" : "ascending"}`}
                      >
                        {order === "asc" ? "↑ Low first" : "↓ High first"}
                      </button>
                    </div>
                    {results.selectionNote && (
                      <details className="selection-note">
                        <summary>How hikes are combined</summary>
                        <p>{results.selectionNote}</p>
                      </details>
                    )}
                    {pages(results, (offset) => void changePage(offset))}
                  </>
                )}
                {selectedId ? (
                  selected ? (
                    <RouteDetails
                      route={selected}
                      jobId={viewedJob.id}
                      resultsRevision={viewedJob.resultsRevision ?? 0}
                      onBack={() => {
                        clearSelection();
                        if (mapDataset) moveTo(mapDataset.bounds);
                      }}
                      backDisabled={false}
                      onReverse={() => {
                        const otherId = selected.reverseId ?? selected.oppositeId;
                        if (otherId) {
                          startsOperation.current?.abort();
                          setLoadingStarts(false);
                          setSelectedId(otherId);
                          setShowStarts(false);
                        }
                      }}
                      reversing={!!selectedId && geometry?.id !== selectedId}
                      reversed={selected.id !== originalDirectionId.current}
                      directionError={routeError}
                      onRetry={() => setRouteRetry((value) => value + 1)}
                    >
                      {selected.groupSize > 1 && (
                        <>
                          <button
                            type="button"
                            className="text-button"
                            aria-expanded={showStarts}
                            aria-controls="starting-point-choices"
                            onClick={() =>
                              showStarts
                                ? setShowStarts(false)
                                : void loadStarts()
                            }
                          >
                            {showStarts
                              ? "Close starting points"
                              : `Choose from ${selected.groupSize.toLocaleString()} starting points`}
                          </button>
                          {showStarts && (
                            <div
                              id="starting-point-choices"
                              className="starting-point-choices"
                            >
                              <h3>Starting points for this hike</h3>
                              {loadingStarts ? (
                                <p role="status">Loading starting points…</p>
                              ) : startsError ? (
                                <p role="alert">
                                  {startsError}
                                  <button
                                    type="button"
                                    onClick={() => void loadStarts()}
                                  >
                                    Retry
                                  </button>
                                </p>
                              ) : (
                                starts && (
                                  <>
                                    {pages(
                                      starts,
                                      (offset) => void loadStarts(offset),
                                      true,
                                    )}
                                    <ul className="start-list">
                                      {starts.routes.map((route) => (
                                        <li key={route.id}>
                                          <button
                                            type="button"
                                            aria-current={
                                              route.startId === selected.startId
                                                ? "true"
                                                : undefined
                                            }
                                            onClick={() => pickRoute(route.id)}
                                          >
                                            <span>{startName(route)}</span>
                                            <small>
                                              {route.startKind === "trailhead"
                                                ? "Trailhead"
                                                : route.startKind === "parking"
                                                  ? "Parking"
                                                  : "Road contact"}{" "}
                                              · {miles(route.distance)} mi · ↑{" "}
                                              {feet(route.gain)} ft
                                              {route.uncertain
                                                ? " · Access uncertain"
                                                : ""}
                                            </small>
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                )
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </RouteDetails>
                  ) : (
                    <div className="direction-status">
                      <button
                        type="button"
                        className="text-button"
                        onClick={clearSelection}
                      >
                        ← All hikes
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
                  )
                ) : results.routes.length ? (
                  <ol className="route-list">
                    {results.routes.map((route) => (
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
                          {route.trailNames.length > 2 && (
                            <span className="route-trails">
                              Also: {route.trailNames.slice(2).join(" · ")}
                            </span>
                          )}
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
                            {route.kind === "lollipop" ? "Lollipop" : "Loop"}
                            {route.roadDistance > 0
                              ? ` · ${(route.roadDistance / MILE).toFixed(2)} mi road connections`
                              : ""}
                            {route.uncertain ? " · Access uncertain" : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty-state">
                    No qualifying hikes were found by this search. Copy these
                    settings to try a different search.
                  </p>
                )}
              </section>
            </>
          ) : null}
        </div>
        {dataset && (
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
        )}
      </aside>
      {mapDataset && camera ? (
        <HikeMap
          dataset={mapDataset}
          selectedSections={
            editing ? regions : (viewedJob?.query.sections ?? regions)
          }
          editing={editing}
          locked={busy || downloading || choosingDownload}
          routes={editing ? [] : locations}
          activeRoute={activeRoute}
          selectedId={selectedId}
          selectedGroupId={selected?.groupId}
          routeNotice={
            activeId
              ? routeError || (!activeRoute ? "Loading route drawing…" : "")
              : ""
          }
          onRetryRoute={
            routeError ? () => setRouteRetry((value) => value + 1) : undefined
          }
          camera={camera}
          onToggleSection={toggleRegion}
          onSelect={pickRoute}
          onPreview={setHoveredId}
        />
      ) : (
        <div className="map-placeholder" />
      )}
      <JobsDialog
        open={jobsOpen}
        jobs={jobs}
        regionName={regionName}
        highlightedId={highlightedJob}
        error={jobActionError || jobsError}
        pending={pendingJob}
        onClose={() => setJobsOpen(false)}
        onRefresh={() => setJobsRetry((value) => value + 1)}
        onView={(job) => void openResults(job)}
        onCopy={copySettings}
        onAction={(job, action) => void mutateJob(job, action)}
      />
    </main>
  );
}
