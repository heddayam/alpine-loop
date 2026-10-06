import { useEffect, useRef, useState } from "react";
import {
  map as createMap,
  tileLayer,
  polyline,
  layerGroup,
  marker,
  divIcon,
  geoJSON,
  DomEvent,
  type Map as LeafletMap,
  type LayerGroup,
  type LatLngBoundsExpression,
} from "leaflet";
import type { Bounds, HikeRoute, RouteLocation } from "../model.js";
import type { CatalogView } from "../data-format.js";
import { clusterLocations } from "./clusters.js";

const leafletBounds = (bounds: Bounds): LatLngBoundsExpression => [
  [bounds[1], bounds[0]],
  [bounds[3], bounds[2]],
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
  const instance = useRef<LeafletMap | null>(null);
  const routeGroup = useRef<LayerGroup | null>(null);
  const startGroup = useRef<LayerGroup | null>(null);
  const sectionGroup = useRef<LayerGroup | null>(null);
  const [chooser, setChooser] = useState<RouteLocation[]>([]);
  const callbacks = useRef({
    onToggleSection,
    onSelect,
    onPreview,
    selectedId,
    editing,
    locked,
  });
  callbacks.current = {
    onToggleSection,
    onSelect,
    onPreview,
    selectedId,
    editing,
    locked,
  };
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (chooser.length) document.getElementById("map-chooser-title")?.focus();
  }, [chooser]);

  useEffect(() => {
    const map = createMap(container.current!);
    instance.current = map;
    map.zoomControl.setPosition("bottomright");
    map.fitBounds(leafletBounds(dataset.bounds), { padding: [30, 30] });
    tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.createPane("sections").style.zIndex = "350";
    sectionGroup.current = layerGroup().addTo(map);
    routeGroup.current = layerGroup().addTo(map);
    startGroup.current = layerGroup().addTo(map);
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(container.current!);
    setReady(true);
    return () => {
      resize.disconnect();
      map.remove();
      instance.current = null;
      routeGroup.current = null;
      startGroup.current = null;
      sectionGroup.current = null;
    };
  }, [dataset.id]);

  useEffect(() => {
    if (!ready || !sectionGroup.current) return;
    sectionGroup.current.clearLayers();
    for (const section of dataset.sections) {
      const selected = selectedSections.includes(section.id);
      const polygon = geoJSON(section.boundary, {
        pane: "sections",
        style: {
          color: selected ? "#315e49" : "#7f8d7f",
          weight: selected ? 3 : 1.5,
          opacity: selected ? 0.9 : 0.65,
          fillOpacity: selected ? 0.14 : 0.015,
          dashArray: section.installed ? undefined : "3 5",
        },
      }).addTo(sectionGroup.current);
      const label = document.createElement("span");
      label.textContent = section.name;
      polygon.bindTooltip(label, { sticky: true });
      polygon.on("click", (event) => {
        if (!callbacks.current.editing || callbacks.current.locked) return;
        DomEvent.stopPropagation(event.originalEvent);
        callbacks.current.onToggleSection(section.id);
      });
    }
  }, [ready, dataset.sections, selectedSections]);

  useEffect(() => {
    if (!ready || !routeGroup.current) return;
    const group = routeGroup.current;
    group.clearLayers();
    if (!activeRoute) return;
    const line = polyline(
      activeRoute.geometry.map(([longitude, latitude]) => [
        latitude,
        longitude,
      ]),
      { color: "#b95b2c", weight: 5, opacity: 0.9 },
    ).addTo(group);
    line.on("click", (event) => {
      DomEvent.stopPropagation(event.originalEvent);
      callbacks.current.onSelect(activeRoute.id);
    });
  }, [ready, activeRoute]);
  useEffect(() => {
    const map = instance.current,
      group = startGroup.current;
    if (!ready || !map || !group) return;
    setChooser([]);
    const draw = () => {
      group.clearLayers();
      for (const cluster of clusterLocations(routes, (route) =>
        map.project(
          [route.startPosition[1], route.startPosition[0]],
          map.getZoom(),
        ),
      )) {
        const choices = cluster.routes;
        const active = choices.some(
          (route) =>
            route.id === selectedId || route.groupId === selectedGroupId,
        );
        const multiple = choices.length > 1;
        const dot = marker([cluster.position[1], cluster.position[0]], {
          icon: divIcon({
            className: `hike-marker${multiple ? " hike-cluster" : ""}${active ? " selected" : ""}`,
            html: multiple
              ? `<span>${choices.length.toLocaleString()}</span>`
              : "<span></span>",
            iconSize: multiple ? [32, 32] : [14, 14],
            iconAnchor: multiple ? [16, 16] : [7, 7],
          }),
          title: multiple
            ? `${choices.length} hikes${cluster.coincident ? " at this starting point" : " nearby"}`
            : choices[0]!.startName || "Hike starting point",
        }).addTo(group);
        const label = document.createElement("span");
        label.textContent = multiple
          ? `${choices.length} hikes · ${cluster.coincident ? "choose a hike" : "zoom to explore"}`
          : choices[0]!.startName || "Unnamed start";
        dot.bindTooltip(label, { direction: "right" });
        if (!multiple) {
          dot.on("mouseover", () =>
            callbacks.current.onPreview(choices[0]!.id),
          );
          dot.on("mouseout", () => callbacks.current.onPreview(null));
        }
        dot.on("click", (event) => {
          DomEvent.stopPropagation(event.originalEvent);
          callbacks.current.onPreview(null);
          if (!multiple) {
            setChooser([]);
            callbacks.current.onSelect(choices[0]!.id);
          } else if (cluster.coincident || map.getZoom() >= 19)
            setChooser(choices);
          else {
            setChooser([]);
            map.fitBounds(
              choices.map((route) => [
                route.startPosition[1],
                route.startPosition[0],
              ]),
              { padding: [60, 60], maxZoom: 19 },
            );
          }
        });
      }
    };
    draw();
    map.on("zoomend", draw);
    return () => {
      map.off("zoomend", draw);
      group.clearLayers();
    };
  }, [ready, routes, selectedId, selectedGroupId]);
  useEffect(() => {
    const map = instance.current;
    if (!ready || !map) return;
    map.fitBounds(leafletBounds(camera.bounds), {
      padding: [camera.padding ?? 40, camera.padding ?? 40],
      animate: false,
    });
  }, [ready, camera]);

  return (
    <section className="map-panel" aria-label="Hike map">
      <div className="map-canvas" ref={container} />
      {!editing && routeNotice && (
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
      {!!chooser.length && !editing && (
        <section className="map-chooser" aria-labelledby="map-chooser-title">
          <header>
            <h2 id="map-chooser-title" tabIndex={-1}>
              Choose a hike
            </h2>
            <button
              type="button"
              aria-label="Close hike chooser"
              onClick={() => {
                callbacks.current.onPreview(null);
                setChooser([]);
              }}
            >
              ×
            </button>
          </header>
          <p>{chooser.length} hikes at this location</p>
          <ul>
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
                    setChooser([]);
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
          </ul>
        </section>
      )}
      <span className="map-caption">
        {editing
          ? "Shaded regions are selected. Solid borders: downloaded. Dotted borders: download available."
          : "All completed hikes are on the map. Numbered clusters zoom; shared starting points offer a hike chooser."}
        {editing && !locked && " Click a region to select it."}
      </span>
    </section>
  );
}
