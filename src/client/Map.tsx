import { useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  MercatorCoordinate,
  setWorkerUrl,
  type GeoJSONSource,
  type ExpressionSpecification,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Bounds, HikeRoute, RouteLocation, Position } from "../model.js";
import type { Boundary } from "../data-format.js";
import { clusterLocations } from "./clusters.js";

setWorkerUrl(workerUrl);
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
  routeNotice,
  onRetryRoute,
  camera,
  onSelect,
  onPreview,
  onBoundsChange,
  onBrowse,
  profilePosition,
}: {
  sections: { id: string; boundary: Boundary }[];
  selectedSections: string[];
  routes: RouteLocation[];
  activeRoute: HikeRoute | null;
  selectedId: string | null;
  selectedGroupId?: string;
  routeNotice: string;
  onRetryRoute?: () => void;
  camera: { bounds: Bounds; revision: number; padding?: number };
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  onBoundsChange: (bounds: Bounds) => void;
  onBrowse: (bounds: Bounds) => void;
  profilePosition: Position | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [mapError, setMapError] = useState("");
  const starts = useRef<{ marker: Marker; routes: RouteLocation[] }[]>([]);
  const profileMarker = useRef<Marker | null>(null);
  const callbacks = useRef({
    onSelect,
    onPreview,
    selectedId,
    selectedGroupId,
    onBoundsChange,
    onBrowse,
  });
  callbacks.current = {
    onSelect,
    onPreview,
    selectedId,
    selectedGroupId,
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
    const publishBounds = () => {
      const bounds = instance.getBounds();
      callbacks.current.onBoundsChange([
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ]);
    };
    instance.on("moveend", publishBounds);
    instance.on("resize", publishBounds);
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
    if (!map || !profilePosition || !activeRoute) {
      profileMarker.current?.remove();
      profileMarker.current = null;
      return;
    }
    if (!profileMarker.current) {
      const dot = document.createElement("span");
      dot.className = "profile-map-marker";
      dot.setAttribute("aria-hidden", "true");
      profileMarker.current = new Marker({ element: dot })
        .setLngLat([profilePosition[0], profilePosition[1]])
        .addTo(map);
    } else {
      profileMarker.current.setLngLat([profilePosition[0], profilePosition[1]]);
    }
  }, [map, profilePosition, activeRoute]);

  const highlightStarts = () => {
    const { selectedId, selectedGroupId } = callbacks.current;
    for (const start of starts.current) {
      start.marker.getElement().classList.toggle(
        "selected",
        start.routes.some(
          (route) =>
            route.id === selectedId || route.groupId === selectedGroupId,
        ),
      );
    }
  };
  useEffect(() => {
    highlightStarts();
  }, [map, selectedId, selectedGroupId]);
  useEffect(() => {
    if (!map) return;
    const clear = () => {
      for (const start of starts.current) start.marker.remove();
      starts.current = [];
    };
    const draw = () => {
      clear();
      // World coordinates keep cluster membership independent of panning.
      const scale = 512 * 2 ** map.getZoom();
      for (const cluster of clusterLocations(routes, (route) => {
        const [longitude, latitude] = route.startPosition;
        const point = MercatorCoordinate.fromLngLat([longitude, latitude]);
        return { x: point.x * scale, y: point.y * scale };
      })) {
        const choices = cluster.routes;
        const multiple = choices.length > 1;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `hike-marker${multiple ? " hike-cluster" : ""}`;
        button.textContent = multiple ? choices.length.toLocaleString() : "";
        button.title = multiple
          ? `${choices.length} hikes · zoom to browse`
          : choices[0]!.startName || "Unnamed start";
        button.setAttribute("aria-label", button.title);
        if (!multiple) {
          for (const event of ["pointerenter", "focus"])
            button.addEventListener(event, () =>
              callbacks.current.onPreview(choices[0]!.id),
            );
          for (const event of ["pointerleave", "blur"])
            button.addEventListener(event, () =>
              callbacks.current.onPreview(null),
            );
        }
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          callbacks.current.onPreview(null);
          if (!multiple) {
            callbacks.current.onSelect(choices[0]!.id);
          } else {
            const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
            for (const {
              startPosition: [longitude, latitude],
            } of choices) {
              bounds[0] = Math.min(bounds[0], longitude);
              bounds[1] = Math.min(bounds[1], latitude);
              bounds[2] = Math.max(bounds[2], longitude);
              bounds[3] = Math.max(bounds[3], latitude);
            }
            callbacks.current.onBrowse(bounds);
          }
        });
        starts.current.push({
          marker: new Marker({ element: button })
            .setLngLat(cluster.position)
            .addTo(map),
          routes: choices,
        });
      }
      highlightStarts();
    };
    draw();
    map.on("zoomend", draw);
    return () => {
      map.off("zoomend", draw);
      clear();
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
