import { useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
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
import { HikeMarkers } from "./HikeMarkers.js";
import { request } from "./request.js";
import { mergedRegionBoundary } from "./region-outline.js";
import { boundaryGeometry } from "../boundary.js";
import { BoundaryDrawing } from "./BoundaryDrawing.js";
import { MapCoordinates } from "./MapCoordinates.js";
import { routeDrawing } from "./route-drawing.js";
import { unitsFor, type UnitSystem } from "./units.js";

setWorkerUrl(workerUrl);
// One local search already uses the CPU; Safari otherwise starts up to three map workers.
setWorkerCount(1);
const empty = { type: "FeatureCollection" as const, features: [] };
const PATHS_MIN_ZOOM = 8;
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
function peakElevationFeet(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 2 && value[0] === "get" && value[1] === "ele")
    return [
      "case",
      ["all", ["has", "ele"], ["!=", ["get", "ele"], ""]],
      ["to-string", ["round", ["/", ["to-number", ["get", "ele"]], unitsFor("imperial").elevation]]],
      "",
    ];
  return value.map(peakElevationFeet);
}
export function HikeMap({
  units,
  sections,
  selectedSections,
  routes,
  pathsURL,
  selectedRoute,
  previewRoute,
  selectedId,
  previewId,
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
  units: UnitSystem;
  sections: { id: string; boundary: Boundary }[];
  selectedSections: string[];
  routes: RouteLocation[];
  pathsURL?: string;
  selectedRoute: HikeRoute | null;
  previewRoute: HikeRoute | null;
  selectedId: string | null;
  previewId: string | null;
  camera: { bounds: Bounds; revision: number; padding?: number; bottomPadding?: number };
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
  const peakLabels = useRef(new Map<string, ExpressionSpecification>());
  const [mapError, setMapError] = useState("");
  const [pathsError, setPathsError] = useState("");
  const [pathsRetry, setPathsRetry] = useState(0);
  const [segmentLabel, setSegmentLabel] = useState<{ routeId: string; name: string } | null>(null);
  const [startLabel, setStartLabel] = useState<string | null>(null);
  const clearSegmentHover = useRef<() => void>(() => {});
  const profileMarker = useRef<Marker | null>(null);
  const callbacks = useRef({
    onSelect,
    onPreview,
    selectedId,
    previewId,
    onBoundsChange,
    onBrowse,
    drawingBoundary,
  });
  callbacks.current = {
    onSelect,
    onPreview,
    selectedId,
    previewId,
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
      const basemapLayers = instance.getStyle().layers;
      const firstLabel = basemapLayers.find(
        (layer) => layer.type === "symbol" && layer.layout?.["text-field"],
      )?.id;
      for (const layer of basemapLayers) {
        // Reserve raspberry for the selected hike; keep the network's zoom and rank hierarchy.
        if (layer.id === "road_hiking")
          instance.setPaintProperty(layer.id, "line-color", [
            "interpolate", ["linear"], ["zoom"], 6, "#8993a3", 12,
            ["match", ["get", "walking_network"],
              "iwn", "#667085", "nwn", "#727d90", "rwn", "#7e899a", "#8993a3"],
          ]);
        if (layer.id === "road_hiking_label")
          instance.setPaintProperty(layer.id, "text-halo-color", "#667085");
        if (layer.id === "road_hiking_shield" || layer.id === "road_hiking_node_shield") {
          instance.setPaintProperty(layer.id, "icon-color", "#667085");
          instance.setPaintProperty(layer.id, "icon-halo-color", "#ffffff");
        }
        if (layer.id === "road_path_label" || layer.id === "road_hiking_label")
          instance.setLayoutProperty(layer.id, "text-offset", [0, -0.8]);
        if (layer.id === "road_minor_label")
          instance.setLayoutProperty(layer.id, "text-offset", [
            "match", ["get", "type"],
            "track", ["literal", [0, -0.8]],
            "minor", ["literal", [0, -0.6]], ["literal", [0, 0]],
          ]);
        if (layer.type === "symbol" && layer.id.startsWith("place_peak_label_"))
          peakLabels.current.set(
            layer.id,
            layer.layout?.["text-field"] as ExpressionSpecification,
          );
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
      instance.addSource("preview-route", { type: "geojson", data: empty });
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
      const colors = getComputedStyle(container.current!);
      const resultColor = colors.getPropertyValue("--action").trim();
      const routeColor = colors.getPropertyValue("--active-route").trim();
      // Keep alternatives legible on terrain, with the focused hike above them.
      instance.addLayer({
        id: "result-paths",
        type: "line",
        source: "result-paths",
        minzoom: PATHS_MIN_ZOOM,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": resultColor,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 12, 2.5, 16, 3],
          "line-opacity": 1,
        },
      }, firstLabel);
      instance.addLayer({
        id: "result-paths-hit", type: "line", source: "result-paths", minzoom: PATHS_MIN_ZOOM,
        paint: { "line-width": 8, "line-opacity": 0 },
      }, firstLabel);
      instance.addLayer({
        id: "result-paths-preview", type: "line", source: "result-paths", minzoom: PATHS_MIN_ZOOM,
        filter: ["==", ["get", "id"], ""],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": routeColor, "line-width": 3 },
      }, firstLabel);
      instance.addLayer({
        id: "preview-route", type: "line", source: "preview-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": routeColor, "line-width": 3 },
      }, firstLabel);
      instance.addLayer({
        id: "route-background",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["case", ["boolean", ["feature-state", "hover"], false], routeColor, "#ffffff"],
          "line-width": 6,
        },
      }, firstLabel);
      instance.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": routeColor,
          "line-width": 4,
          "line-opacity": 1,
        },
      }, firstLabel);
      const pathAt = (point: { x: number; y: number }) => {
        const features = instance.queryRenderedFeatures(
          [[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]],
          { layers: ["route", "preview-route", "result-paths-hit"] },
        );
        // Shared overview paths must not steal the focused hike's segment hit.
        return features.find(feature => feature.layer.id === "route"
          && feature.properties.id === callbacks.current.selectedId) ?? features[0];
      };
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
        // Marker events bubble through the map; the trail beneath must not take their hover.
        if (event.originalEvent.target instanceof Element
            && event.originalEvent.target.closest(".hike-marker")) {
          clearHover();
          return;
        }
        // Hit-test at most once per frame, using the latest pointer position.
        cancelAnimationFrame(hoverFrame);
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          const feature = pathAt(event.point);
          const id = feature?.properties.id;
          instance.getCanvas().style.cursor = typeof id === "string" ? "pointer" : "";
          if (feature?.layer.id === "route" && id === callbacks.current.selectedId && feature.id !== undefined) {
            hoverSegment(feature.id, id, feature.properties.name);
            callbacks.current.onPreview(null);
          } else {
            hoverSegment();
            callbacks.current.onPreview(typeof id === "string" ? id : null);
          }
        });
      });
      instance.on("movestart", () => { clearHover(); setStartLabel(null); callbacks.current.onPreview(null); });
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
    for (const [id, original] of peakLabels.current)
      map.setLayoutProperty(
        id,
        "text-field",
        units === "metric" ? original : peakElevationFeet(original) as ExpressionSpecification,
      );
  }, [map, units]);

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
    const contains = (outer: Bounds, inner: Bounds) => inner[0] >= outer[0] && inner[1] >= outer[1]
      && inner[2] <= outer[2] && inner[3] <= outer[3];
    source.setData(empty);
    setPathsError("");
    const load = () => {
      if (!pathsURL || map.getZoom() < PATHS_MIN_ZOOM) {
        controller?.abort();
        loadedBounds = null;
        source.setData(empty);
        setPathsError("");
        return;
      }
      const bounds = map.getBounds();
      const view: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
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
        source.setData({
          type: "FeatureCollection",
          features: loadedPaths.map(path => ({
            type: "Feature", properties: { id: path.routeIds[0], routeIds: path.routeIds },
            geometry: { type: "LineString", coordinates: path.geometry },
          })),
        });
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
    (map.getSource("route") as GeoJSONSource).setData(
      selectedRoute ? routeDrawing(selectedRoute) : empty,
    );
  }, [map, selectedRoute]);

  useEffect(() => {
    clearSegmentHover.current();
    setStartLabel(null);
  }, [selectedId, drawingBoundary]);

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

  useEffect(() => {
    if (!map) return;
    const id = previewId !== selectedId ? previewId : null;
    map.setFilter("result-paths-preview", id
      ? ["in", id, ["get", "routeIds"]] : ["==", ["get", "id"], ""]);
    (map.getSource("preview-route") as GeoJSONSource).setData(
      id && previewRoute?.id === id ? routeDrawing(previewRoute) : empty,
    );
  }, [map, selectedId, previewId, previewRoute]);

  useEffect(() => {
    if (!map) return;
    map.resize();
    const padding = camera.padding ?? 40;
    map.fitBounds(camera.bounds, {
      padding: { top: padding, right: padding, bottom: camera.bottomPadding ?? padding, left: padding },
      maxZoom: 17,
      duration: 0,
    });
  }, [map, camera]);

  return (
    <section className="map-panel" aria-label="Hike map">
      <div className="map-canvas" ref={container} />
      <MapCoordinates map={map} />
      <HikeMarkers map={map} routes={routes} selectedId={selectedId} previewId={previewId}
        disabled={drawingBoundary} onSelect={onSelect} onPreview={onPreview} onBrowse={onBrowse}
        onInspect={name => { clearSegmentHover.current(); setStartLabel(name); }} />
      {!drawingBoundary && (startLabel || segmentLabel?.routeId === selectedId) && (
        <div className="map-segment-label">{startLabel || segmentLabel?.name}</div>
      )}
      {drawingBoundary && <BoundaryDrawing map={map} onFinish={onFinishBoundary} onCancel={onCancelBoundary} />}
      {mapError && (
        <div className="map-notice preview-notice" role="alert">
          {mapError}
        </div>
      )}
      {pathsError && !mapError && (
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
