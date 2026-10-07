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
import type { Bounds, HikeRoute, RouteLocation } from "../model.js";
import type { Boundary } from "../data-format.js";
import type { ProfileCursor } from "./ElevationProfile.js";
import { clusterLocations } from "./clusters.js";

setWorkerUrl(workerUrl);
// One local search already uses the CPU; Safari otherwise starts up to three map workers.
setWorkerCount(1);
const empty = { type: "FeatureCollection" as const, features: [] };
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
  activeRoute,
  selectedId,
  selectedGroupId,
  selectedLocationIds,
  routeNotice,
  onRetryRoute,
  camera,
  onSelect,
  onPreview,
  onBoundsChange,
  onBrowse,
  profileCursor,
}: {
  sections: { id: string; boundary: Boundary }[];
  selectedSections: string[];
  routes: RouteLocation[];
  activeRoute: HikeRoute | null;
  selectedId: string | null;
  selectedGroupId?: string;
  selectedLocationIds?: ReadonlySet<string>;
  routeNotice: string;
  onRetryRoute?: () => void;
  camera: { bounds: Bounds; revision: number; padding?: number };
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  onBoundsChange: (bounds: Bounds, userMoved: boolean) => void;
  onBrowse: (ids: string[]) => void;
  profileCursor: ProfileCursor;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [mapError, setMapError] = useState("");
  const starts = useRef(new Map<string, {
    marker: Marker;
    routes: RouteLocation[];
    position: [number, number];
  }>());
  const profileMarker = useRef<Marker | null>(null);
  const callbacks = useRef({
    onSelect,
    onPreview,
    selectedId,
    selectedGroupId,
    selectedLocationIds,
    onBoundsChange,
    onBrowse,
  });
  callbacks.current = {
    onSelect,
    onPreview,
    selectedId,
    selectedGroupId,
    selectedLocationIds,
    onBoundsChange,
    onBrowse,
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
    instance.on("click", "route", (event) => {
      const id = event.features?.[0]?.properties.id;
      if (typeof id === "string") callbacks.current.onSelect(id);
    });
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
      instance.addLayer({
        id: "sections-outline",
        type: "line",
        source: "sections",
        paint: {
          "line-color": "#555555",
          "line-width": 1,
          "line-opacity": 0.65,
        },
      });
      instance.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#b95b2c",
          "line-width": 5,
          "line-opacity": 0.9,
        },
      });
      setMapError("");
      setMap(instance);
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current!);
    return () => {
      resize.disconnect();
      profileMarker.current?.remove();
      profileMarker.current = null;
      instance.remove();
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    (map.getSource("sections") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: sections
        .filter((section) => selectedSections.includes(section.id))
        .map((section) => ({
          type: "Feature",
          geometry: section.boundary,
          properties: {},
        })),
    });
  }, [map, sections, selectedSections]);

  useEffect(() => {
    if (!map) return;
    (map.getSource("route") as GeoJSONSource).setData(
      activeRoute
        ? {
            type: "Feature",
            properties: { id: activeRoute.id },
            geometry: { type: "LineString", coordinates: activeRoute.geometry },
          }
        : empty,
    );
  }, [map, activeRoute]);

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
    const { selectedId, selectedGroupId, selectedLocationIds } =
      callbacks.current;
    for (const start of starts.current.values()) {
      start.marker.getElement().classList.toggle(
        "selected",
        start.routes.some(
          (route) =>
            route.id === selectedId ||
            route.groupId === selectedGroupId ||
            selectedLocationIds?.has(route.id),
        ),
      );
    }
  };
  useEffect(() => {
    highlightStarts();
  }, [map, selectedId, selectedGroupId, selectedLocationIds]);
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
          entry = {
            marker: new Marker({ element: button }),
            routes: cluster.routes,
            position: cluster.position,
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
            if (current.routes.length === 1) callbacks.current.onSelect(current.routes[0]!.id);
            else callbacks.current.onBrowse(current.routes.map((route) => route.id));
            map.easeTo({
              center: current.position,
              zoom: Math.max(map.getZoom(), Math.min(map.getZoom() + 1, 13)),
              duration: 350,
            });
          });
          starts.current.set(cluster.key, entry);
          entry.marker.setLngLat(cluster.position).addTo(map);
        }
        entry.routes = cluster.routes;
        entry.position = cluster.position;
        entry.marker.setLngLat(cluster.position);
        const button = entry.marker.getElement();
        const multiple = cluster.routes.length > 1;
        button.className = `hike-marker${multiple ? " hike-cluster" : ""}`;
        button.textContent = multiple ? cluster.routes.length.toLocaleString() : "";
        button.title = multiple ? `${cluster.routes.length} hikes · browse` : cluster.routes[0]!.startName || "Unnamed start";
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
      duration: 350,
    });
  }, [map, camera]);

  return (
    <section className="map-panel" aria-label="Hike map">
      <div className="map-canvas" ref={container} />
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
