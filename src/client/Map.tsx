import { useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  Popup,
  NavigationControl,
  MercatorCoordinate,
  setWorkerUrl,
  type GeoJSONSource,
  type ExpressionSpecification,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Bounds, HikeRoute, RouteLocation } from "../model.js";
import type { CatalogView } from "../data-format.js";
import { clusterLocations } from "./clusters.js";
import { regionLabel } from "./RegionPicker.js";

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
  const weight = pointLabel && value === "Ysabeau Bold"
    ? "Bold" : bluredWeights[value];
  return weight ? `Averia Serif Libre ${weight}` : value;
}
const selected: ExpressionSpecification = [
  "boolean", ["feature-state", "selected"], false,
];

export function HikeMap({
  dataset,
  selectedSections,
  editing,
  locked,
  routes,
  activeRoute,
  selectedId,
  selectedGroupId,
  routeNotice,
  onRetryRoute,
  camera,
  onToggleSection,
  onSelect,
  onPreview,
}: {
  dataset: CatalogView;
  selectedSections: string[];
  editing: boolean;
  locked: boolean;
  routes: RouteLocation[];
  activeRoute: HikeRoute | null;
  selectedId: string | null;
  selectedGroupId?: string;
  routeNotice: string;
  onRetryRoute?: () => void;
  camera: { bounds: Bounds; revision: number; padding?: number };
  onToggleSection: (id: string) => void;
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [mapError, setMapError] = useState("");
  const sectionTooltip = useRef<Popup | null>(null);
  const starts = useRef<{ marker: Marker; routes: RouteLocation[] }[]>([]);
  const [chooser, setChooser] = useState<RouteLocation[] | null>(null);
  const callbacks = useRef({
    onToggleSection,
    onSelect,
    onPreview,
    selectedId,
    selectedGroupId,
    editing,
    locked,
  });
  callbacks.current = {
    onToggleSection,
    onSelect,
    onPreview,
    selectedId,
    selectedGroupId,
    editing,
    locked,
  };
  useEffect(() => {
    if (chooser) document.getElementById("map-chooser-title")?.focus();
  }, [chooser]);

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
    instance.addControl(
      new NavigationControl({ showCompass: false }), "bottom-right",
    );
    const tooltip = new Popup({
      closeButton: false, closeOnClick: false, offset: 12,
    });
    sectionTooltip.current = tooltip;
    instance.on("mousemove", "sections-fill", (event) => {
      if (!callbacks.current.editing || callbacks.current.locked) {
        tooltip.remove();
        instance.getCanvas().style.cursor = "";
        return;
      }
      const name = event.features?.[0]?.properties.name;
      if (typeof name === "string")
        tooltip.setLngLat(event.lngLat).setText(name).addTo(instance);
      instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", "sections-fill", () => {
      tooltip.remove();
      instance.getCanvas().style.cursor = "";
    });
    instance.on("movestart", () => tooltip.remove());
    instance.on("click", "sections-fill", (event) => {
      if (!callbacks.current.editing || callbacks.current.locked) return;
      if (instance.queryRenderedFeatures(event.point, { layers: ["route"] }).length) return;
      const id = event.features?.[0]?.properties.id;
      if (typeof id === "string") callbacks.current.onToggleSection(id);
    });
    instance.on("click", "route", (event) => {
      const id = event.features?.[0]?.properties.id;
      if (typeof id === "string") callbacks.current.onSelect(id);
    });
    instance.on("error", () => {
      if (!instance.getStyle())
        setMapError("The basemap could not load. Check your connection and reload the page.");
    });
    instance.once("style.load", () => {
      if (new URLSearchParams(window.location.search).get("canopy") !== "off") {
        for (const id of ["nature_natural", "nature_natural_texture"]) {
          const filter = instance.getFilter(id);
          if (filter) instance.setFilter(id, [
            "all", filter as ExpressionSpecification,
            ["!=", ["get", "type"], "wood"],
          ]);
        }
        instance.addSource("tree-canopy", {
          type: "raster", tileSize: 256, minzoom: 6, maxzoom: 12,
          bounds: [-128, 22, -65, 52],
          tiles: [
            "https://dmsdata.cr.usgs.gov/geoserver/mrlc_NLCD-Tree-Canopy-Native_conus_year_data/wms"
            + "?service=WMS&version=1.1.1&request=GetMap&layers=NLCD-Tree-Canopy-Native_conus_year_data"
            + "&styles=&format=image/png&transparent=true&srs=EPSG:3857"
            + "&bbox={bbox-epsg-3857}&width=256&height=256&time=2025-01-01",
          ],
          attribution: 'Tree canopy: <a href="https://www.mrlc.gov/data-services-page">USFS / NLCD 2025</a>',
        });
        instance.addLayer({
          id: "tree-canopy", type: "raster", source: "tree-canopy",
          paint: { "raster-opacity": 0.4 },
        }, "nature_natural_texture");
      }
      for (const layer of instance.getStyle().layers) {
        if (layer.type !== "symbol" || !layer.layout?.["text-font"]) continue;
        instance.setLayoutProperty(layer.id, "text-font", bluredFont(
          layer.layout["text-font"], layer.id.startsWith("place_point_label"),
        ) as ExpressionSpecification);
      }
      instance.addSource("sections", {
        type: "geojson", data: empty, promoteId: "id",
      });
      instance.addSource("route", { type: "geojson", data: empty });
      instance.addLayer({
        id: "sections-fill",
        type: "fill",
        source: "sections",
        paint: {
          "fill-opacity": 0,
        },
      });
      instance.addLayer({
        id: "sections-outline",
        type: "line",
        source: "sections",
        paint: {
          "line-color": "#555555",
          "line-width": 1,
          "line-opacity": ["case", selected, 0.65, 0],
        },
      });
      instance.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#b95b2c", "line-width": 5, "line-opacity": 0.9,
        },
      });
      setMapError("");
      setMap(instance);
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current!);
    return () => {
      resize.disconnect();
      tooltip.remove();
      sectionTooltip.current = null;
      instance.remove();
    };
  }, []);

  useEffect(() => {
    if (!editing || locked) {
      sectionTooltip.current?.remove();
      if (map) map.getCanvas().style.cursor = "";
    }
  }, [map, editing, locked]);

  useEffect(() => {
    if (!map) return;
    (map.getSource("sections") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: dataset.sections.map((section) => ({
        type: "Feature",
        id: section.id,
        geometry: section.boundary,
        properties: {
          id: section.id, name: regionLabel(section.name),
        },
      })),
    });
  }, [map, dataset.sections]);
  useEffect(() => {
    if (!map) return;
    for (const section of dataset.sections) {
      map.setFeatureState(
        { source: "sections", id: section.id },
        { selected: selectedSections.includes(section.id) },
      );
    }
  }, [map, dataset.sections, selectedSections]);

  useEffect(() => {
    if (!map) return;
    (map.getSource("route") as GeoJSONSource).setData(
      activeRoute ? {
        type: "Feature",
        properties: { id: activeRoute.id },
        geometry: { type: "LineString", coordinates: activeRoute.geometry },
      } : empty,
    );
  }, [map, activeRoute]);

  const highlightStarts = () => {
    const { selectedId, selectedGroupId } = callbacks.current;
    for (const start of starts.current) {
      start.marker.getElement().classList.toggle(
        "selected", start.routes.some(
          (route) => route.id === selectedId || route.groupId === selectedGroupId,
        ),
      );
    }
  };
  useEffect(() => {
    highlightStarts();
    setChooser(null);
  }, [map, selectedId, selectedGroupId]);
  useEffect(() => {
    if (!map) return;
    setChooser(null);
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
          ? `${choices.length} hikes · choose a hike`
          : choices[0]!.startName || "Unnamed start";
        button.setAttribute("aria-label", button.title);
        if (!multiple) {
          for (const event of ["pointerenter", "focus"])
            button.addEventListener(event, () =>
              callbacks.current.onPreview(choices[0]!.id),
            );
          for (const event of ["pointerleave", "blur"])
            button.addEventListener(event, () => callbacks.current.onPreview(null));
        }
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          callbacks.current.onPreview(null);
          if (!multiple) {
            setChooser(null);
            callbacks.current.onSelect(choices[0]!.id);
          } else setChooser(choices);
        });
        starts.current.push({
          marker: new Marker({ element: button }).setLngLat(cluster.position).addTo(map),
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
    map.fitBounds(camera.bounds, {
      padding: camera.padding ?? 40,
      duration: 350,
    });
  }, [map, camera]);

  return (
    <section className="map-panel" aria-label="Hike map">
      <div className="map-canvas" ref={container} />
      {!!routes.length && (
        <button
          type="button"
          className="map-browse"
          disabled={!map}
          aria-expanded={chooser !== null}
          aria-controls="map-hike-chooser"
          onClick={() => {
            callbacks.current.onPreview(null);
            const bounds = map!.getBounds();
            setChooser(routes.filter(({ startPosition: [longitude, latitude] }) =>
              bounds.contains([longitude, latitude]),
            ));
          }}
        >
          Hikes in view
        </button>
      )}
      {mapError && (
        <div className="map-notice preview-notice" role="alert">{mapError}</div>
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
      {chooser !== null && (
        <section
          id="map-hike-chooser"
          className="map-chooser"
          aria-labelledby="map-chooser-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              callbacks.current.onPreview(null);
              setChooser(null);
            }
          }}
        >
          <header>
            <h2 id="map-chooser-title" tabIndex={-1}>
              Choose a hike
            </h2>
            <button
              type="button"
              aria-label="Close hike chooser"
              onClick={() => {
                callbacks.current.onPreview(null);
                setChooser(null);
              }}
            >
              ×
            </button>
          </header>
          <p>{chooser.length ? `${chooser.length} hikes` : "No hikes in view."}</p>
          {!!chooser.length && <ul>
            {chooser.map((route) => (
              <li key={route.id}>
                <button
                  type="button"
                  onPointerEnter={() => callbacks.current.onPreview(route.id)}
                  onPointerLeave={() => callbacks.current.onPreview(null)}
                  onFocus={() => callbacks.current.onPreview(route.id)}
                  onBlur={() => callbacks.current.onPreview(null)}
                  onClick={() => {
                    callbacks.current.onPreview(null);
                    callbacks.current.onSelect(route.id);
                    setChooser(null);
                  }}
                >
                  <strong>
                    {route.trailNames.slice(0, 2).join(" / ") ||
                      route.startName ||
                      "Unnamed trails"}
                  </strong>
                  <span>
                    {(route.distance / 1609.344).toFixed(1)} mi ·{" "}
                    {route.startName || "Unnamed start"}
                  </span>
                </button>
              </li>
            ))}
          </ul>}
        </section>
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
