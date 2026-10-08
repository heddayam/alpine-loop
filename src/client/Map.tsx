import { useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  MercatorCoordinate,
  setWorkerUrl,
  setWorkerCount,
  type GeoJSONSource,
  type ExpressionSpecification,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Bounds, HikeRoute, RouteLocation, RoutePath, SearchBoundary } from "../model.js";
import type { Boundary } from "../data-format.js";
import type { ProfileCursor } from "./ElevationProfile.js";
import { clusterLocations } from "./clusters.js";
import { request } from "./request.js";
import { mergedRegionBoundary } from "./region-outline.js";
import { boundaryGeometry } from "../boundary.js";
import { BoundaryDrawing } from "./BoundaryDrawing.js";
import { dashedPaths } from "./path-dashes.js";

setWorkerUrl(workerUrl);
// One local search already uses the CPU; Safari otherwise starts up to three map workers.
setWorkerCount(1);
const empty = { type: "FeatureCollection" as const, features: [] };
const PATHS_MIN_ZOOM = 9;
// Match MapMaker's "Blured" preset while keeping its non-Latin font fallbacks.
const bluredWeights: Record<string, string> = {
  "Ysabeau Regular": "Regular",
  "Ysabeau Bold": "Regular",
  "Ysabeau Small Caps Regular": "Regular",
  "Ysabeau Small Caps Bold": "Bold",
  "Ysabeau Extrabold Italic": "Bold Italic",
  "Ysabeau Medium Italic": "Italic",
  "Ysabeau Italic": "Light Italic",
};
function bluredFont(value: unknown, pointLabel: boolean): unknown {
  if (Array.isArray(value))
    return value.map((item) => bluredFont(item, pointLabel));
  if (typeof value !== "string") return value;
  const weight =
    pointLabel && value === "Ysabeau Bold" ? "Bold" : bluredWeights[value];
  return weight ? `Averia Serif Libre ${weight}` : value;
}
export function HikeMap({
  sections,
  selectedSections,
  routes,
  pathsURL,
  activeRoute,
  selectedId,
  focusedId,
  routeNotice,
  onRetryRoute,
  camera,
  onSelect,
  onPreview,
  onBoundsChange,
  onBrowse,
  profileCursor,
  boundary,
  drawingBoundary,
  onFinishBoundary,
  onCancelBoundary,
}: {
  sections: { id: string; boundary: Boundary }[];
  selectedSections: string[];
  routes: RouteLocation[];
  pathsURL?: string;
  activeRoute: HikeRoute | null;
  selectedId: string | null;
  focusedId: string | null;
  routeNotice: string;
  onRetryRoute?: () => void;
  camera: { bounds: Bounds; revision: number; padding?: number };
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  onBoundsChange: (bounds: Bounds, userMoved: boolean) => void;
  onBrowse: (ids: string[]) => void;
  profileCursor: ProfileCursor;
  boundary?: SearchBoundary;
  drawingBoundary: boolean;
  onFinishBoundary: (boundary: SearchBoundary) => string | null;
  onCancelBoundary: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [mapError, setMapError] = useState("");
  const [pathsError, setPathsError] = useState("");
  const [pathsRetry, setPathsRetry] = useState(0);
  const [segmentLabel, setSegmentLabel] = useState<{ routeId: string; name: string } | null>(null);
  const clearSegmentHover = useRef<() => void>(() => {});
  const starts = useRef(new Map<string, {
    marker: Marker;
    routes: RouteLocation[];
  }>());
  const profileMarker = useRef<Marker | null>(null);
  const callbacks = useRef({
    onSelect,
    onPreview,
    selectedId,
    focusedId,
    onBoundsChange,
    onBrowse,
    drawingBoundary,
  });
  callbacks.current = {
    onSelect,
    onPreview,
    selectedId,
    focusedId,
    onBoundsChange,
    onBrowse,
    drawingBoundary,
  };

  useEffect(() => {
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: container.current!,
        bounds: camera.bounds,
        fitBoundsOptions: { padding: camera.padding ?? 40 },
        maxZoom: 19,
        // Bound inactive tiles per source; visible tiles remain available at every zoom.
        maxTileCacheSize: 16,
        maxTileCacheZoomLevels: 1,
        dragRotate: false,
        touchPitch: false,
        renderWorldCopies: false,
        attributionControl: { compact: false, customAttribution: "" },
        style: "https://styles.maptoolkit.org/hiking.json",
      });
    } catch {
      setMapError(
        "The map could not start. Reload the page or try a browser with graphics acceleration enabled.",
      );
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();
    const publishBounds = (userMoved = false) => {
      const bounds = instance.getBounds();
      callbacks.current.onBoundsChange(
        [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ],
        userMoved,
      );
    };
    instance.on("moveend", (event) => publishBounds(!!event.originalEvent));
    instance.on("resize", () => publishBounds());
    publishBounds();
    instance.addControl(
      new NavigationControl({ showCompass: false }),
      "bottom-right",
    );
    instance.on("error", () => {
      if (!instance.getStyle())
        setMapError(
          "The basemap could not load. Check your connection and reload the page.",
        );
    });
    instance.once("style.load", () => {
      if (new URLSearchParams(window.location.search).get("canopy") !== "off") {
        for (const id of ["nature_natural", "nature_natural_texture"]) {
          const filter = instance.getFilter(id);
          if (filter)
            instance.setFilter(id, [
              "all",
              filter as ExpressionSpecification,
              ["!=", ["get", "type"], "wood"],
            ]);
        }
        instance.addSource("tree-canopy", {
          type: "raster",
          tileSize: 256,
          minzoom: 6,
          maxzoom: 12,
          bounds: [-128, 22, -65, 52],
          tiles: [
            "https://dmsdata.cr.usgs.gov/geoserver/mrlc_NLCD-Tree-Canopy-Native_conus_year_data/wms" +
              "?service=WMS&version=1.1.1&request=GetMap&layers=NLCD-Tree-Canopy-Native_conus_year_data" +
              "&styles=&format=image/png&transparent=true&srs=EPSG:3857" +
              "&bbox={bbox-epsg-3857}&width=256&height=256&time=2025-01-01",
          ],
          attribution:
            'Tree canopy: <a href="https://www.mrlc.gov/data-services-page">USFS / NLCD 2025</a>',
        });
        instance.addLayer(
          {
            id: "tree-canopy",
            type: "raster",
            source: "tree-canopy",
            paint: { "raster-opacity": 0.4 },
          },
          "nature_natural_texture",
        );
      }
      for (const layer of instance.getStyle().layers) {
        if (layer.type !== "symbol" || !layer.layout?.["text-font"]) continue;
        instance.setLayoutProperty(
          layer.id,
          "text-font",
          bluredFont(
            layer.layout["text-font"],
            layer.id.startsWith("place_point_label"),
          ) as ExpressionSpecification,
        );
      }
      instance.addSource("sections", {
        type: "geojson",
        data: empty,
      });
      instance.addSource("route", { type: "geojson", data: empty });
      instance.addSource("result-paths", { type: "geojson", data: empty });
      instance.addSource("search-boundary", { type: "geojson", data: empty });
      instance.addLayer({
        id: "sections-outline",
        type: "line",
        source: "sections",
        paint: {
          "line-color": "#557f9b",
          "line-width": 2,
          "line-opacity": 0.9,
        },
      });
      instance.addLayer({
        id: "search-boundary-outline", type: "line", source: "search-boundary",
        paint: { "line-color": "#557f9b", "line-width": 2, "line-dasharray": [3, 2] },
      });
      instance.addLayer({
        id: "result-paths",
        type: "line",
        source: "result-paths",
        minzoom: PATHS_MIN_ZOOM,
        filter: ["==", ["get", "hit"], false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#58615b",
          "line-width": 2,
          "line-opacity": 1,
        },
      });
      instance.addLayer({
        id: "result-paths-hit", type: "line", source: "result-paths", minzoom: PATHS_MIN_ZOOM,
        filter: ["==", ["get", "hit"], true],
        paint: { "line-width": 8, "line-opacity": 0 },
      });
      instance.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#b95b2c",
          "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 6, 4],
          "line-opacity": 0.9,
        },
      });
      const pathAt = (point: { x: number; y: number }) =>
        instance.queryRenderedFeatures(
          [[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]],
          { layers: ["route", "result-paths-hit"] },
        )[0];
      let hoveredSegment: string | number | undefined;
      let hoverFrame = 0;
      const hoverSegment = (id?: string | number, routeId?: string, name?: string) => {
        if (id === hoveredSegment) return;
        if (hoveredSegment !== undefined)
          instance.setFeatureState({ source: "route", id: hoveredSegment }, { hover: false });
        hoveredSegment = id;
        if (id !== undefined)
          instance.setFeatureState({ source: "route", id }, { hover: true });
        setSegmentLabel(routeId && name ? { routeId, name } : null);
      };
      const clearHover = () => {
        cancelAnimationFrame(hoverFrame);
        hoverFrame = 0;
        hoverSegment();
        instance.getCanvas().style.cursor = "";
      };
      clearSegmentHover.current = clearHover;
      instance.on("mousemove", (event) => {
        if (callbacks.current.drawingBoundary) return;
        if (instance.isMoving()) return;
        // Hit-test at most once per frame, using the latest pointer position.
        cancelAnimationFrame(hoverFrame);
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          const feature = pathAt(event.point);
          const id = feature?.properties.id;
          instance.getCanvas().style.cursor = typeof id === "string" ? "pointer" : "";
          if (feature?.layer.id === "route" && id === callbacks.current.focusedId && feature.id !== undefined) {
            hoverSegment(feature.id, id, feature.properties.name);
            callbacks.current.onPreview(null);
          } else {
            hoverSegment();
            callbacks.current.onPreview(typeof id === "string" ? id : null);
          }
        });
      });
      instance.on("movestart", clearHover);
      instance.on("mouseout", () => { clearHover(); callbacks.current.onPreview(null); });
      instance.on("click", (event) => {
        if (callbacks.current.drawingBoundary) return;
        const id = pathAt(event.point)?.properties.id;
        if (typeof id === "string") {
          callbacks.current.onPreview(null);
          callbacks.current.onSelect(id);
        }
      });
      setMapError("");
      setMap(instance);
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current!);
    return () => {
      clearSegmentHover.current();
      clearSegmentHover.current = () => {};
      resize.disconnect();
      profileMarker.current?.remove();
      profileMarker.current = null;
      instance.remove();
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    const boundary = mergedRegionBoundary(
      sections
        .filter((section) => selectedSections.includes(section.id))
        .map((section) => section.boundary),
    );
    (map.getSource("sections") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: boundary.coordinates.length
        ? [{ type: "Feature", geometry: boundary, properties: {} }]
        : [],
    });
  }, [map, sections, selectedSections]);

  useEffect(() => {
    if (!map) return;
    (map.getSource("search-boundary") as GeoJSONSource).setData(boundary && !drawingBoundary
      ? { type: "Feature", properties: {}, geometry: boundaryGeometry(boundary) } : empty);
    map.setPaintProperty("sections-outline", "line-opacity", drawingBoundary ? 0.5 : boundary ? 0.25 : 0.9);
  }, [map, boundary, drawingBoundary]);

  useEffect(() => {
    if (!map) return;
    const source = map.getSource("result-paths") as GeoJSONSource;
    let controller: AbortController | undefined;
    let loadedBounds: Bounds | null = null;
    let paths: RoutePath[] = [];
    let drawnZoom = -1;
    let drawnBounds: Bounds | null = null;
    const contains = (outer: Bounds, inner: Bounds) => inner[0] >= outer[0] && inner[1] >= outer[1]
      && inner[2] <= outer[2] && inner[3] <= outer[3];
    const render = () => {
      const bounds = map.getBounds(), zoom = Math.floor(map.getZoom());
      const view: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      if (zoom === drawnZoom && drawnBounds && contains(drawnBounds, view)) return;
      const x = (view[2] - view[0]) / 4, y = (view[3] - view[1]) / 4;
      drawnBounds = [view[0] - x, view[1] - y, view[2] + x, view[3] + y];
      drawnZoom = zoom;
      source.setData(dashedPaths(paths, zoom, drawnBounds));
    };
    source.setData(empty);
    setPathsError("");
    const load = () => {
      if (!pathsURL || map.getZoom() < PATHS_MIN_ZOOM) {
        controller?.abort();
        loadedBounds = null;
        paths = [];
        drawnBounds = null;
        source.setData(empty);
        setPathsError("");
        return;
      }
      const bounds = map.getBounds();
      const view: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      render();
      if (loadedBounds && contains(loadedBounds, view)) return;
      controller?.abort();
      const pending = new AbortController();
      controller = pending;
      // Keep only one surrounding window; short pans reuse it without another request.
      const x = (view[2] - view[0]) / 4, y = (view[3] - view[1]) / 4;
      loadedBounds = [Math.max(-180, view[0] - x), Math.max(-90, view[1] - y),
        Math.min(180, view[2] + x), Math.min(90, view[3] + y)];
      const url = new URL(pathsURL, window.location.href);
      ["west", "south", "east", "north"].forEach((key, index) => url.searchParams.set(key, String(loadedBounds![index])));
      setPathsError("");
      void request<RoutePath[]>(url.toString(), pending.signal).then((loadedPaths) => {
        if (pending.signal.aborted) return;
        paths = loadedPaths;
        drawnBounds = null;
        render();
      }).catch(() => {
        if (!pending.signal.aborted) {
          loadedBounds = null;
          setPathsError("Other route paths could not load.");
        }
      });
    };
    load();
    map.on("moveend", load);
    map.on("resize", load);
    return () => {
      controller?.abort();
      map.off("moveend", load);
      map.off("resize", load);
    };
  }, [map, pathsURL, pathsRetry]);

  useEffect(() => {
    if (!map) return;
    clearSegmentHover.current();
    map.removeFeatureState({ source: "route" });
    // Each physical segment is uploaded once, even for a returning stem.
    const segments = new Map(activeRoute?.segments?.map(segment => [segment.id, segment]));
    (map.getSource("route") as GeoJSONSource).setData(
      activeRoute
        ? segments.size ? {
            type: "FeatureCollection",
            features: [...segments.values()].map((segment, index) => ({
              type: "Feature",
              // Vector tile encoding requires numeric IDs. Source replacement
              // clears state, so collection indices are stable for this drawing.
              id: index,
              properties: { id: activeRoute.id, name: segment.name === undefined ? "Trail name unavailable" : segment.name || "Unnamed trail" },
              geometry: { type: "LineString", coordinates: activeRoute.geometry.slice(segment.start, segment.end + 1).map(point => [point[0], point[1]]) },
            })),
          } : {
            type: "Feature",
            properties: { id: activeRoute.id },
            geometry: { type: "LineString", coordinates: activeRoute.geometry.map(point => [point[0], point[1]]) },
          }
        : empty,
    );
  }, [map, activeRoute]);

  useEffect(() => {
    clearSegmentHover.current();
  }, [focusedId, drawingBoundary]);

  useEffect(() => {
    if (!map) return;
    return profileCursor.subscribe((position) => {
      if (!position) {
        profileMarker.current?.remove();
        profileMarker.current = null;
      } else if (!profileMarker.current) {
        const dot = document.createElement("span");
        dot.className = "profile-map-marker";
        dot.setAttribute("aria-hidden", "true");
        profileMarker.current = new Marker({ element: dot })
          .setLngLat([position[0], position[1]]).addTo(map);
      } else profileMarker.current.setLngLat([position[0], position[1]]);
    });
  }, [map, profileCursor]);

  const highlightStarts = () => {
    const { selectedId } =
      callbacks.current;
    for (const start of starts.current.values()) {
      start.marker.getElement().classList.toggle(
        "selected",
        start.routes.some(
          (route) =>
            route.id === selectedId,
        ),
      );
    }
  };
  useEffect(() => {
    highlightStarts();
  }, [map, selectedId]);
  useEffect(() => {
    if (!map) return;
    // World cells are stable across panning, and integer zooms avoid reclustering during animations.
    const positions = new Map(routes.map((route) => [
      route.id, MercatorCoordinate.fromLngLat([route.startPosition[0], route.startPosition[1]]),
    ]));
    let zoom = -1;
    let clusters: ReturnType<typeof clusterLocations> = [];
    const draw = () => {
      const nextZoom = Math.floor(map.getZoom());
      if (nextZoom !== zoom) {
        zoom = nextZoom;
        const scale = 512 * 2 ** zoom;
        clusters = clusterLocations(routes, (route) => {
          const point = positions.get(route.id)!;
          return { x: point.x * scale, y: point.y * scale };
        });
      }
      const bounds = map.getBounds();
      const xMargin = (bounds.getEast() - bounds.getWest()) / 4;
      const yMargin = (bounds.getNorth() - bounds.getSouth()) / 4;
      const visible = new Set<string>();
      for (const cluster of clusters) {
        const [longitude, latitude] = cluster.position;
        if (longitude < bounds.getWest() - xMargin || longitude > bounds.getEast() + xMargin ||
            latitude < bounds.getSouth() - yMargin || latitude > bounds.getNorth() + yMargin) continue;
        visible.add(cluster.key);
        let entry = starts.current.get(cluster.key);
        if (!entry) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "hike-marker";
          entry = {
            marker: new Marker({ element: button }),
            routes: cluster.routes,
          };
          const current = entry;
          for (const event of ["pointerenter", "focus"])
            button.addEventListener(event, () => {
              if (current.routes.length === 1) callbacks.current.onPreview(current.routes[0]!.id);
            });
          for (const event of ["pointerleave", "blur"])
            button.addEventListener(event, () => callbacks.current.onPreview(null));
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            callbacks.current.onPreview(null);
            if (current.routes.length === 1) {
              callbacks.current.onSelect(current.routes[0]!.id);
              return;
            }
            callbacks.current.onBrowse(current.routes.map((route) => route.id));
          });
          starts.current.set(cluster.key, entry);
          entry.marker.setLngLat(cluster.position).addTo(map);
        }
        entry.routes = cluster.routes;
        entry.marker.setLngLat(cluster.position);
        const button = entry.marker.getElement();
        const multiple = cluster.routes.length > 1;
        // MapLibre owns the positioning and anchor classes on this element.
        button.classList.toggle("hike-cluster", multiple);
        button.textContent = multiple ? cluster.routes.length.toLocaleString() : "";
        button.title = multiple ? `${cluster.routes.length} hikes: browse` : cluster.routes[0]!.startName || "Unnamed start";
        button.setAttribute("aria-label", button.title);
      }
      for (const [key, entry] of starts.current) {
        if (!visible.has(key)) {
          entry.marker.remove();
          starts.current.delete(key);
        }
      }
      highlightStarts();
    };
    draw();
    map.on("moveend", draw);
    return () => {
      map.off("moveend", draw);
      for (const entry of starts.current.values()) entry.marker.remove();
      starts.current.clear();
    };
  }, [map, routes]);
  useEffect(() => {
    if (!map) return;
    map.resize();
    const padding = camera.padding ?? 40;
    map.fitBounds(camera.bounds, {
      padding,
      maxZoom: 17,
      duration: 0,
    });
  }, [map, camera]);

  return (
    <section className="map-panel" aria-label="Hike map">
      <div className="map-canvas" ref={container} />
      {segmentLabel && segmentLabel.routeId === focusedId && !drawingBoundary && (
        <div className="map-segment-label">{segmentLabel.name}</div>
      )}
      {drawingBoundary && <BoundaryDrawing map={map} onFinish={onFinishBoundary} onCancel={onCancelBoundary} />}
      {mapError && (
        <div className="map-notice preview-notice" role="alert">
          {mapError}
        </div>
      )}
      {routeNotice && (
        <div
          className="map-notice preview-notice"
          role={onRetryRoute ? "alert" : "status"}
        >
          <p>{routeNotice}</p>
          {onRetryRoute && (
            <button type="button" onClick={onRetryRoute}>
              Retry drawing
            </button>
          )}
        </div>
      )}
      {pathsError && !mapError && !routeNotice && (
        <div className="map-notice preview-notice" role="alert">
          <p>{pathsError}</p>
          <button type="button" onClick={() => setPathsRetry((value) => value + 1)}>Retry</button>
        </div>
      )}
      <a
        className="map-provider"
        href="https://www.maptoolkit.org/"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img
          src="https://www.maptoolkit.org/assets/maptoolkit-attribution.png"
          alt="Maptoolkit"
          height={24}
        />
      </a>
    </section>
  );
}
