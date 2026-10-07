import {
  useEffect,
  useRef,
  useState,
  useMemo,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Bounds,
  RouteChoice,
  RouteSummary,
  RouteView,
  SearchQuery,
  JobSnapshot,
  JobResults,
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
import { ElevationProfile } from "./ElevationProfile.js";

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
  children,
  onReverse,
  reversing,
  reversed,
  directionError,
  onRetry,
  onProfileHover,
}: {
  route: SelectedRoute;
  jobId: string;
  resultsRevision: number;
  onBack: () => void;
  children: ReactNode;
  onReverse: () => void;
  reversing: boolean;
  reversed: boolean;
  directionError: string;
  onRetry: () => void;
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
          </div>
          {children}
          <p className="route-kind">
            {route.kind === "lollipop" ? "Lollipop" : "Loop"}
          </p>
          {(route.reverseId || route.oppositeId) && (
            <button
              type="button"
              className="text-button reverse-direction"
              onClick={onReverse}
            >
              {reversed
                ? "Use original direction"
                : route.reverseId
                  ? "Reverse direction"
                  : "Other loop direction"}
            </button>
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
              <dt>Repeated</dt>
              <dd>
                {Math.round(route.repetition * 100)}
                <small>%</small>
              </dd>
            </div>
          </dl>
          {route.geometry && (
            <ElevationProfile
              key={route.id}
              route={{ ...route, geometry: route.geometry }}
              onHover={onProfileHover}
            />
          )}
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
  filter: { group: string } | { variant: string },
) => {
  const parameters = new URLSearchParams({
    offset: String(offset),
    sort: "distance",
    order: "asc",
  });
  if ("group" in filter) parameters.set("group", filter.group);
  else parameters.set("variant", filter.variant);
  return `?${parameters}`;
};
type ChoiceKind = "versions" | "starts";
type SelectedRoute = RouteChoice & { geometry?: Position[] };

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
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const downloadDialog = useRef<HTMLDialogElement>(null);
  const [highlightedJob, setHighlightedJob] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState("");
  const [jobActionError, setJobActionError] = useState("");
  const [jobsRetry, setJobsRetry] = useState(0);
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
  const [resultLimit, setResultLimit] = useState(50);
  const resultList = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedRoute | null>(null);
  const [profilePosition, setProfilePosition] = useState<Position | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<RouteView | null>(null);
  const [routeError, setRouteError] = useState("");
  const [routeRetry, setRouteRetry] = useState(0);
  const originalDirectionId = useRef<string | null>(null);
  const focusedRouteId = useRef<string | null>(null);
  const [choiceKind, setChoiceKind] = useState<ChoiceKind | null>(null);
  const [choices, setChoices] = useState<JobResults>();
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [choicesError, setChoicesError] = useState("");
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
  const choicesOperation = useRef<AbortController | null>(null);
  const viewedRevisions = useRef(new Map<string, number>());
  const initialJobId = useRef(
    new URLSearchParams(window.location.search).get("job"),
  );
  const downloading = download?.status === "running";
  const choosingDownload = !!pendingDownload;
  const activeId = hoveredId ?? selectedId;
  const activeRoute = useMemo(
    () =>
      geometry?.id === activeId
        ? geometry
        : selected?.id === activeId && selected.geometry
          ? { ...selected, geometry: selected.geometry }
          : null,
    [geometry, activeId, selected],
  );
  useEffect(
    () => setProfilePosition(null),
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
    setResultLimit(50);
    setHoveredId(null);
    if (resultList.current) resultList.current.scrollTop = 0;
  }, [visibleLocations]);
  const mapDataset =
    !showSearchArea && viewedJob ? (savedMap(viewedJob) ?? dataset) : dataset;
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
  const closeChoices = () => {
    choicesOperation.current?.abort();
    setLoadingChoices(false);
    setChoiceKind(null);
    setChoices(undefined);
    setChoicesError("");
    setHoveredId(null);
  };
  const clearSelection = () => {
    closeChoices();
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
      choicesOperation.current?.abort();
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
    if (selected?.id === activeId && selected.geometry) {
      setGeometry({ ...selected, geometry: selected.geometry });
      setRouteError("");
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
          if (focusedRouteId.current !== route.id) {
            focusedRouteId.current = route.id;
            requestAnimationFrame(() =>
              document.getElementById("route-detail-heading")?.focus(),
            );
          }
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
  }, [
    viewedJob?.id,
    viewedJob?.resultsRevision,
    activeId,
    selectedId,
    routeRetry,
  ]);
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
      const next = await request<JobSnapshot[]>("/api/jobs", controller.signal);
      setJobs(next);
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
      setJobs((current) => [
        job,
        ...current.filter((item) => item.id !== job.id),
      ]);
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
    if (id === selectedId) {
      closeChoices();
      if (!selected?.geometry) setRouteRetry((value) => value + 1);
      return;
    }
    focusedRouteId.current = null;
    setSelected(choices?.routes.find((route) => route.id === id) ?? null);
    setSelectedId(id);
    originalDirectionId.current = id;
    closeChoices();
  };
  const loadChoices = async (kind: ChoiceKind, offset = 0) => {
    if (!selected || !viewedJob) return;
    choicesOperation.current?.abort();
    const controller = new AbortController();
    choicesOperation.current = controller;
    setChoiceKind(kind);
    if (!offset) setChoices(undefined);
    setLoadingChoices(true);
    setChoicesError("");
    setHoveredId(null);
    try {
      const page = await request<JobResults>(
        savedResultsURL(
          viewedJob,
          "results",
          resultQuery(
            offset,
            kind === "versions"
              ? { group: selected.groupId }
              : { variant: selected.variantId },
          ),
        ),
        controller.signal,
      );
      if (!controller.signal.aborted && choicesOperation.current === controller)
        setChoices((current) =>
          offset && current
            ? {
                ...page,
                offset: 0,
                routes: [...current.routes, ...page.routes],
              }
            : page,
        );
    } catch (failure) {
      if (!controller.signal.aborted && choicesOperation.current === controller)
        setChoicesError(
          failure instanceof Error
            ? failure.message
            : `${kind === "versions" ? "Route versions" : "Starting points"} could not load.`,
        );
    } finally {
      if (!controller.signal.aborted && choicesOperation.current === controller)
        setLoadingChoices(false);
    }
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
            {(jobActionError || jobsError) && !jobsOpen && (
              <div className="error-banner" role="alert">
                {jobActionError || jobsError}
                <button
                  type="button"
                  onClick={() => setJobsRetry((value) => value + 1)}
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
                profilePosition={profilePosition}
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
                      onReverse={() => {
                        const otherId =
                          selected.reverseId ?? selected.oppositeId;
                        if (otherId) {
                          closeChoices();
                          setSelectedId(otherId);
                        }
                      }}
                      reversing={selected.id !== selectedId}
                      reversed={selected.id !== originalDirectionId.current}
                      directionError={hoveredId ? "" : routeError}
                      onRetry={() => setRouteRetry((value) => value + 1)}
                      onProfileHover={setProfilePosition}
                    >
                      {(selected.variantCount > 1 ||
                        selected.groupSize > 1) && (
                        <div className="route-choices">
                          <div className="route-choice-actions">
                            {selected.variantCount > 1 && (
                              <button
                                type="button"
                                className="text-button"
                                aria-expanded={choiceKind === "versions"}
                                aria-controls="route-choice-list"
                                onClick={() =>
                                  choiceKind === "versions"
                                    ? closeChoices()
                                    : void loadChoices("versions")
                                }
                              >
                                {choiceKind === "versions"
                                  ? "Close route versions"
                                  : `Compare ${selected.variantCount.toLocaleString()} route versions`}
                              </button>
                            )}
                            {selected.groupSize > 1 && (
                              <button
                                type="button"
                                className="text-button"
                                aria-expanded={choiceKind === "starts"}
                                aria-controls="route-choice-list"
                                onClick={() =>
                                  choiceKind === "starts"
                                    ? closeChoices()
                                    : void loadChoices("starts")
                                }
                              >
                                {choiceKind === "starts"
                                  ? "Close starting points"
                                  : `Choose from ${selected.groupSize.toLocaleString()} starting points`}
                              </button>
                            )}
                          </div>
                          {choiceKind && (
                            <div
                              id="route-choice-list"
                              className="route-choice-list"
                            >
                              <h3>
                                {choiceKind === "versions"
                                  ? "Route versions"
                                  : "Starting points for this version"}
                              </h3>
                              {choices && (
                                <ul
                                  className="choice-list"
                                  onScroll={(event) => {
                                    const list = event.currentTarget;
                                    if (
                                      list.scrollHeight -
                                        list.scrollTop -
                                        list.clientHeight <
                                        80 &&
                                      !loadingChoices &&
                                      !choicesError &&
                                      choices.routes.length < choices.pageTotal
                                    ) {
                                      void loadChoices(
                                        choiceKind,
                                        choices.routes.length,
                                      );
                                    }
                                  }}
                                >
                                  {choices.routes.map((route) => (
                                    <li key={route.id}>
                                      <button
                                        type="button"
                                        aria-current={
                                          (
                                            choiceKind === "versions"
                                              ? route.variantId ===
                                                selected.variantId
                                              : route.startId ===
                                                selected.startId
                                          )
                                            ? "true"
                                            : undefined
                                        }
                                        onClick={() => pickRoute(route.id)}
                                        onPointerEnter={() =>
                                          setHoveredId(route.id)
                                        }
                                        onPointerLeave={() =>
                                          setHoveredId(null)
                                        }
                                        onFocus={() => setHoveredId(route.id)}
                                        onBlur={() => setHoveredId(null)}
                                      >
                                        <span>
                                          {choiceKind === "versions"
                                            ? routeName(route)
                                            : startName(route)}
                                        </span>
                                        {choiceKind === "versions" && (
                                          <small>{startName(route)}</small>
                                        )}
                                        <small>
                                          {miles(route.distance)} mi · ↑{" "}
                                          {feet(route.gain)} ft
                                          {route.roadDistance > 0
                                            ? ` · ${(route.roadDistance / MILE).toFixed(2)} mi roads`
                                            : ""}
                                          {route.uncertain
                                            ? " · Access uncertain"
                                            : ""}
                                        </small>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {loadingChoices && <p role="status">Loading…</p>}
                              {choicesError && (
                                <p role="alert">
                                  {choicesError}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void loadChoices(
                                        choiceKind,
                                        choices?.routes.length ?? 0,
                                      )
                                    }
                                  >
                                    Retry
                                  </button>
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </RouteDetails>
                  ) : (
                    <div className="direction-status">
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
                <div
                  className="results-list"
                  ref={resultList}
                  onScroll={(event) => {
                    const list = event.currentTarget;
                    if (
                      list.scrollHeight - list.scrollTop - list.clientHeight <
                      80
                    )
                      setResultLimit((limit) =>
                        Math.min(visibleLocations.length, limit + 50),
                      );
                  }}
                >
                  <ul className="hike-list">
                    {visibleLocations.slice(0, resultLimit).map((route) => (
                      <li key={route.id}>
                        <button
                          type="button"
                          onPointerEnter={() => setHoveredId(route.id)}
                          onPointerLeave={() => setHoveredId(null)}
                          onFocus={() => setHoveredId(route.id)}
                          onBlur={() => setHoveredId(null)}
                          onClick={() => pickRoute(route.id)}
                        >
                          <strong>
                            {route.trailNames.slice(0, 2).join(" / ") ||
                              route.startName ||
                              "Unnamed trails"}
                          </strong>
                          <span>
                            {miles(route.distance)} mi ·{" "}
                            {route.startName || "Unnamed start"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
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
    </div>
  );
}
