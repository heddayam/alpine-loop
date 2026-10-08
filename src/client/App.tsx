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
  RouteView,
  SearchQuery,
  JobSnapshot,
  RouteLocation,
} from "../model.js";
import type {
  CatalogView,
  Coverage,
  DownloadSnapshot,
} from "../data-format.js";
import {
  JobsDialog,
  activeJob,
  hasSavedResults,
  savedResultsURL,
  elapsed,
  storage,
} from "./JobsDialog.js";

import { boundaryBounds, boundarySections } from "../boundary.js";
import type { SearchBoundary } from "../model.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { locationsInView } from "./clusters.js";
import { createProfileCursor } from "./ElevationProfile.js";
import { request } from "./request.js";
import { useJobs } from "./useJobs.js";
import { RouteCache } from "./RouteCache.js";
import { RouteDock } from "./RouteDock.js";
import {
  SearchControls,
  initialDraft,
  draftForQuery,
  queryForDraft,
  convertDraft,
  type SearchDraft,
} from "./SearchControls.js";
import { readUnitSystem, saveUnitSystem, type UnitSystem } from "./units.js";

const HikeMap = lazy(async () => ({
  default: (await import("./Map.js")).HikeMap,
}));

const combinedBounds = (items: { bounds: Bounds }[]): Bounds => [
  Math.min(...items.map((item) => item.bounds[0])),
  Math.min(...items.map((item) => item.bounds[1])),
  Math.max(...items.map((item) => item.bounds[2])),
  Math.max(...items.map((item) => item.bounds[3])),
];
const savedMap = (job: JobSnapshot): CatalogView | undefined =>
  job.inputs?.sections.length
    ? {
        id: `saved-${job.id}`,
        name: "Saved search",
        bounds: job.query.boundary ? boundaryBounds(job.query.boundary) : combinedBounds(job.inputs.sections),
        sourceDate: job.inputs.version,
        attribution: [],
        limitations: [],
        startCount: job.progress.totalStarts,
        sections: job.inputs.sections.map((section) => ({
          ...section,
          state: "", regionId: section.id, regionName: section.name,
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
  const [units, setUnits] = useState(readUnitSystem);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const [draft, setDraft] = useState(() => convertDraft(initialDraft, "imperial", units));
  const regions = draft.sections;
  const [drawingBoundary, setDrawingBoundary] = useState(false);
  const [showSearchArea, setShowSearchArea] = useState(true);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
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
  const visibleLocations = useMemo(
    () =>
      typeof resultScope !== "string"
        ? locations.filter((route) => resultScope.has(route.id))
        : resultScope === "all"
          ? locations
          : mapBounds
            ? locationsInView(locations, mapBounds)
            : [],
    [locations, resultScope, mapBounds],
  );
  useEffect(() => {
    setHoveredId(null);
  }, [visibleLocations]);
  const mapDataset = useMemo(
    () =>
      !showSearchArea && viewedJob ? (savedMap(viewedJob) ?? dataset) : dataset,
    [showSearchArea, viewedJob, dataset],
  );
  const visibleBoundary = showSearchArea ? draft.boundary : viewedJob?.query.boundary;
  const regionName = (id: string) =>
    dataset?.sections.find((section) => section.id === id)?.name ?? id;
  const moveTo = (bounds: Bounds, padding = 40) =>
    setCamera((current) => ({
      bounds,
      revision: (current?.revision ?? 0) + 1,
      padding,
    }));
  const frameHikes = (bounds: Bounds) => {
    // Leave nearby terrain visible without making the margin depend on screen size.
    const longitudeMargin = (bounds[2] - bounds[0]) * 0.15;
    const latitudeMargin = (bounds[3] - bounds[1]) * 0.15;
    moveTo([
      bounds[0] - longitudeMargin,
      bounds[1] - latitudeMargin,
      bounds[2] + longitudeMargin,
      bounds[3] + latitudeMargin,
    ]);
  };
  const fitRoute = (id: string) => {
    const route = locations.find((route) => route.id === id);
    if (route) frameHikes(route.bounds);
  };
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
    setDrawingBoundary(false);
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
      setDraft(draftForQuery(fullJob.query, unitsRef.current));
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
    void request<JobSnapshot>(
      `/api/jobs/${encodeURIComponent(id)}?inputs=false`,
      controller.signal,
    )
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
    const key = savedResultsURL(
      viewedJob,
      `routes/${encodeURIComponent(activeId)}`,
    );
    const publish = (route: RouteView) => {
      if (controller.signal.aborted) return;
      setGeometry(route);
      if (selectedId === route.id) {
        setSelected(route);
        if (focusedRouteId.current !== route.id) {
          focusedRouteId.current = route.id;
          fitRoute(route.id);
          requestAnimationFrame(() =>
            document.getElementById("route-detail-heading")?.focus(),
          );
        }
      }
    };
    setRouteError("");
    const cached =
      selected?.id === activeId ? selected : routeCache.current.get(key);
    if (cached) publish(cached);
    else {
      setGeometry(null);
      // Intentional selection loads immediately; passing over a marker does not.
      const timer = setTimeout(
        () => {
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
        },
        activeId === selectedId ? 0 : 120,
      );
      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    }
    return () => controller.abort();
  }, [
    viewedJob?.id,
    viewedJob?.resultsRevision,
    activeId,
    selectedId,
    routeRetry,
  ]);
  const copySettings = (job: JobSnapshot) => {
    setDrawingBoundary(false);
    viewOperation.current?.abort();
    setPendingJob(null);
    const query = job.query;
    setDraft(draftForQuery(query, units));
    setShowSearchArea(true);
    setJobsOpen(false);
    setError("");
    const sections = dataset?.sections.filter((section) =>
      query.sections.includes(section.id),
    );
    if (query.boundary) moveTo(boundaryBounds(query.boundary));
    else if (sections?.length) moveTo(combinedBounds(sections));
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
      else
        jobHistory.upsert(
          await request<JobSnapshot>(
            `/api/jobs/${encodeURIComponent(job.id)}?inputs=false`,
            controller.signal,
          ),
        );
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
  const changeDraft = (next: SearchDraft) => {
    if (busy || downloading || choosingDownload) return;
    setDraft(next);
    setError("");
    setShowSearchArea(true);
    if (next.sections !== draft.sections && !next.boundary) {
      const sections = dataset?.sections.filter((section) =>
        next.sections.includes(section.id),
      );
      if (sections?.length) moveTo(combinedBounds(sections));
    }
  };
  const finishBoundary = (boundary: SearchBoundary): string | null => {
    const matches = boundarySections(boundary, dataset?.sections ?? []);
    if (!matches.length) return "This boundary does not overlap prepared trail data. Draw within a prepared region.";
    changeDraft({ ...draft, boundary, sections: matches.map(section => section.id) });
    setDrawingBoundary(false);
    return null;
  };
  const changeUnits = (next: UnitSystem) => {
    if (next === units) return;
    setDraft((current) => convertDraft(current, units, next));
    setUnits(next);
    saveUnitSystem(next);
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
    let query: SearchQuery;
    try {
      query = queryForDraft(draft, units);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Check your search constraints.",
      );
      return;
    }
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
      if (selected) fitRoute(id);
      else setRouteRetry((value) => value + 1);
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
  const viewedRegions = viewedJob?.query.boundary ? "Drawn boundary" : viewedJob?.query.sections
    .map((id) =>
      dataset?.sections.find((section) => section.id === id)?.name ??
        viewedJob.inputs?.sections.find((section) => section.id === id)?.name ?? id,
    )
    .join(", ");
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Alpine Loop</h1>
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
      <div className="query-bar">
        {dataset ? (
          <SearchControls
            dataset={dataset}
            savedSections={[
              ...(viewedJob?.inputs?.sections ?? []),
              ...jobs.flatMap((job) => job.regions ?? []),
            ]}
            draft={draft}
            disabled={busy || downloading || choosingDownload || drawingBoundary}
            submitting={busy}
            units={units}
            onChange={changeDraft}
            onSubmit={(event) => void launch(event)}
            onDrawBoundary={() => {
              clearSelection();
              setShowSearchArea(true);
              setError("");
              setDrawingBoundary(true);
            }}
          />
        ) : (
          <p className="startup" role={startupError ? "alert" : "status"}>
            {startupError || "Opening trail data…"}
          </p>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {(jobActionError || jobHistory.error) && !jobsOpen && (
          <div className="error-banner" role="alert">
            {jobActionError || jobHistory.error}
            <button type="button" onClick={jobHistory.refresh}>
              Reconnect
            </button>
          </div>
        )}
      </div>
      <main
        className={`workspace${resultsCollapsed || !viewedJob ? " is-results-collapsed" : ""}`}
      >
        {viewedJob && (
          <RouteDock
            key={viewedJob.id}
            job={viewedJob}
            regionNames={viewedRegions ?? "Saved search"}
            units={units}
            hidden={resultsCollapsed}
            routes={visibleLocations}
            total={locations.length}
            scope={resultScope}
            selectedId={selectedId}
            selected={selected}
            loadingMap={!mapBounds}
            routeError={routeError}
            onScope={setResultScope}
            onSelect={pickRoute}
            onPreview={setHoveredId}
            onClear={clearSelection}
            onRetry={() => setRouteRetry((value) => value + 1)}
            onProfileHover={profileCursor.set}
            onClose={closeResults}
          />
        )}
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
            <span aria-hidden="true">{resultsCollapsed ? "›" : "‹"}</span>
          </button>
        )}
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
                  drawingBoundary ? mapDataset.sections.map(section => section.id) : showSearchArea
                    ? regions
                    : (viewedJob?.query.sections ?? regions)
                }
                boundary={visibleBoundary}
                drawingBoundary={drawingBoundary}
                onFinishBoundary={finishBoundary}
                onCancelBoundary={() => setDrawingBoundary(false)}
                routes={drawingBoundary ? [] : locations}
                pathsURL={viewedJob && !drawingBoundary ? savedResultsURL(viewedJob, "paths") : undefined}
                profileCursor={profileCursor}
                activeRoute={activeRoute}
                selectedId={activeId}
                focusedId={selectedId}
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
                  const scope = new Set(ids);
                  clearSelection();
                  setResultsCollapsed(false);
                  setResultScope(scope);
                  frameHikes(
                    combinedBounds(
                      locations.filter((route) => scope.has(route.id)),
                    ),
                  );
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
      </main>
      <footer className="workspace-status">
        {(drawingBoundary || visibleBoundary) && <p className="scope-note">
          {drawingBoundary ? "Draw within the prepared regions outlined on the map."
            : "Search uses starting points inside the drawn boundary. Map movement does not change scope."}
        </p>}
        {downloading ? (
          <div className="activity-status" role="status">
            <span>
              Downloading: {storage(download.completedBytes)} /{" "}
              {storage(download.totalBytes)}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => setSettingsOpen(true)}
            >
              Details
            </button>
            {downloadError && <span role="alert">{downloadError}</span>}
          </div>
        ) : currentJob && currentJob.id !== viewedJob?.id ? (
          <div className="activity-status" role="status">
            <span>
              {currentJob.status === "completed"
                ? "Results ready"
                : currentJob.status === "queued"
                  ? `Queued, position ${currentJob.queuePosition ?? "—"}`
                  : currentJob.status === "running"
                    ? `${currentJob.progress.stage === "saving" ? "Saving" : "Searching"}, ${elapsed(currentJob.progress.elapsedMs)}, ${currentJob.progress.completedRegions.length}/${currentJob.progress.totalRegions} regions`
                    : currentJob.status[0]!.toUpperCase() +
                      currentJob.status.slice(1)}
            </span>
            {currentJob.status === "running" && (
              <progress
                aria-label="Within-region search progress"
                max={currentJob.progress.totalSearchPoints || undefined}
                value={
                  currentJob.progress.totalSearchPoints
                    ? (currentJob.progress.completedSearchPoints ?? 0)
                    : undefined
                }
              />
            )}
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
        ) : viewedJob ? (
          <span>
            Completed: {viewedJob.progress.completedRegions.length}/
            {viewedJob.progress.totalRegions} regions,{" "}
            {elapsed(viewedJob.progress.elapsedMs)}
          </span>
        ) : (
          <span>
            {regions.length} {regions.length === 1 ? "region" : "regions"}{" "}
            selected
          </span>
        )}
      </footer>
      <SettingsDialog
        open={settingsOpen}
        units={units}
        onUnits={changeUnits}
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
          units={units}
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
