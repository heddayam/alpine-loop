import { useEffect, useRef, useState } from "react";
import {
  map as createMap,
  tileLayer,
  polyline,
  layerGroup,
  circleMarker,
  geoJSON,
  DomEvent,
  type Map as LeafletMap,
  type CircleMarker,
  type LayerGroup,
  type LatLngBoundsExpression,
} from "leaflet";
import type { Bounds, HikeRoute, RouteSummary } from "../model.js";
import type { CatalogView } from "../data-format.js";

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
  routes: RouteSummary[];
  activeRoute: HikeRoute | null;
  selectedId: string | null;
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
  const renderedStarts = useRef(
    new Map<string, { marker: CircleMarker; routes: RouteSummary[] }>(),
  );
  const callbacks = useRef({ onToggleSection, onSelect, onPreview, selectedId, editing, locked });
  callbacks.current = { onToggleSection, onSelect, onPreview, selectedId, editing, locked };
  const [ready, setReady] = useState(false);

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
      renderedStarts.current.clear();
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
      activeRoute.geometry.map(([longitude, latitude]) => [latitude, longitude]),
      { color: "#b95b2c", weight: 5, opacity: 0.9 },
    ).addTo(group);
    line.on("click", (event) => {
      DomEvent.stopPropagation(event.originalEvent);
      callbacks.current.onSelect(activeRoute.id);
    });
  }, [ready, activeRoute]);
  useEffect(() => {
    if (!ready || !startGroup.current) return;
    const group = startGroup.current;
    const starts = new Map<string, RouteSummary[]>();
    for (const route of routes) {
      const choices = starts.get(route.startId) ?? [];
      choices.push(route);
      starts.set(route.startId, choices);
    }
    for (const [id, entry] of renderedStarts.current) {
      if (!starts.has(id)) {
        group.removeLayer(entry.marker);
        renderedStarts.current.delete(id);
      }
    }
    for (const [id, choices] of starts) {
      const first = choices[0]!;
      let entry = renderedStarts.current.get(id);
      if (!entry) {
        entry = {
          marker: circleMarker([first.startPosition[1], first.startPosition[0]], {
            radius: 5,
            color: "#315e49",
            weight: 2,
            fillColor: "white",
            fillOpacity: 1,
          }).addTo(group),
          routes: choices,
        };
        const start = entry;
        start.marker.on("mouseover", () =>
          callbacks.current.onPreview(start.routes[0]!.id),
        );
        start.marker.on("mouseout", () => callbacks.current.onPreview(null));
        start.marker.on("click", (event) => {
          DomEvent.stopPropagation(event.originalEvent);
          const route = start.routes.find(
            (route) => route.id === callbacks.current.selectedId,
          ) ?? start.routes[0]!;
          callbacks.current.onSelect(route.id);
        });
        renderedStarts.current.set(id, start);
      }
      entry.routes = choices;
      const label = document.createElement("span");
      label.textContent = `${first.startName || "Unnamed start"} · ${choices.length} ${choices.length === 1 ? "choice" : "choices"} on this page`;
      entry.marker.bindTooltip(label, { direction: "right" });
    }
  }, [ready, routes]);
  useEffect(() => {
    for (const { marker, routes: choices } of renderedStarts.current.values()) {
      const active = choices.some((route) => route.id === selectedId);
      marker.setRadius(active ? 7 : 5).setStyle({
        color: active ? "#b95b2c" : "#315e49",
        opacity: selectedId && !active ? 0.4 : 1,
      });
      if (active) marker.bringToFront();
    }
  }, [ready, routes, selectedId]);
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
            <button type="button" onClick={onRetryRoute}>Retry drawing</button>
          )}
        </div>
      )}
      <span className="map-caption">
        {!editing && !!routes.length && "Dots mark starts on this page. "}
        Shaded regions are selected. Solid borders: downloaded. Dotted borders: download available.
        {editing && !locked && " Click a region to select it."}
      </span>
    </section>
  );
}
