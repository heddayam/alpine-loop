import { useEffect, useRef, useState } from "react";
import {
  map as createMap,
  tileLayer,
  rectangle,
  polyline,
  layerGroup,
  circleMarker,
  geoJSON,
  DomEvent,
  type Map as LeafletMap,
  type Rectangle,
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
const visibleBounds = (map: LeafletMap): Bounds => {
  const bounds = map.getBounds();
  return [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];
};

export function HikeMap({
  dataset,
  area,
  editing,
  locked,
  drawn,
  routes,
  activeRoute,
  selectedId,
  routeNotice,
  onRetryRoute,
  camera,
  onArea,
  onViewport,
  onDrawing,
  onSelect,
  onPreview,
}: {
  dataset: CatalogView;
  area: Bounds | null;
  editing: boolean;
  locked: boolean;
  drawn: boolean;
  routes: RouteSummary[];
  activeRoute: HikeRoute | null;
  selectedId: string | null;
  routeNotice: string;
  onRetryRoute?: () => void;
  camera: { bounds: Bounds; revision: number; selectArea?: boolean; padding?: number };
  onArea: (bounds: Bounds) => void;
  onViewport: (bounds: Bounds) => void;
  onDrawing: (drawing: boolean) => void;
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<LeafletMap | null>(null);
  const outline = useRef<Rectangle | null>(null);
  const routeGroup = useRef<LayerGroup | null>(null);
  const startGroup = useRef<LayerGroup | null>(null);
  const sectionGroup = useRef<LayerGroup | null>(null);
  const renderedStarts = useRef(
    new Map<string, { marker: CircleMarker; routes: RouteSummary[] }>(),
  );
  const callbacks = useRef({
    onArea,
    onViewport,
    onDrawing,
    onSelect,
    onPreview,
    selectedId,
    editing,
    locked,
    drawn,
  });
  callbacks.current = {
    onArea,
    onViewport,
    onDrawing,
    onSelect,
    onPreview,
    selectedId,
    editing,
    locked,
    drawn,
  };
  const programmatic = useRef(false);
  const movedWhileLocked = useRef(false);
  const [ready, setReady] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  const firstCorner = useRef<[number, number] | null>(null);
  const changeDrawing = (next: boolean) => {
    firstCorner.current = null;
    drawingRef.current = next;
    setDrawing(next);
    callbacks.current.onDrawing(next);
  };

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
    outline.current = rectangle(leafletBounds(dataset.bounds), {
      color: "#536553",
      weight: 1.5,
      dashArray: "6 5",
      opacity: 0,
      fillOpacity: 0,
      interactive: false,
    }).addTo(map);
    routeGroup.current = layerGroup().addTo(map);
    startGroup.current = layerGroup().addTo(map);
    map.on("moveend", () => {
      if (
        callbacks.current.editing &&
        !callbacks.current.drawn &&
        !programmatic.current
      ) {
        if (callbacks.current.locked) movedWhileLocked.current = true;
        else callbacks.current.onViewport(visibleBounds(map));
      }
    });
    map.on("click", (event) => {
      if (!drawingRef.current || callbacks.current.locked) return;
      const point: [number, number] = [event.latlng.lng, event.latlng.lat];
      if (!firstCorner.current) {
        firstCorner.current = point;
        return;
      }
      const start = firstCorner.current;
      if (
        Math.abs(start[0] - point[0]) < 0.00001 ||
        Math.abs(start[1] - point[1]) < 0.00001
      )
        return;
      callbacks.current.onArea([
        Math.min(start[0], point[0]),
        Math.min(start[1], point[1]),
        Math.max(start[0], point[0]),
        Math.max(start[1], point[1]),
      ]);
      changeDrawing(false);
    });
    map.on("mousemove", (event) => {
      if (!drawingRef.current || !firstCorner.current) return;
      const [longitude, latitude] = firstCorner.current;
      outline.current
        ?.setBounds([
          [latitude, longitude],
          [event.latlng.lat, event.latlng.lng],
        ])
        .setStyle({ opacity: 1, fillOpacity: 0.035 });
    });
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(container.current!);
    setReady(true);
    return () => {
      resize.disconnect();
      map.remove();
      renderedStarts.current.clear();
      instance.current = null;
      outline.current = null;
      routeGroup.current = null;
      startGroup.current = null;
      sectionGroup.current = null;
    };
  }, [dataset.id]);

  useEffect(() => {
    if (!ready || !sectionGroup.current) return;
    sectionGroup.current.clearLayers();
    for (const section of dataset.sections) {
      geoJSON(section.boundary, {
        pane: "sections",
        interactive: false,
        style: {
          color: section.installed ? "#315e49" : "#7f8d7f",
          weight: section.installed ? 2 : 1.5,
          opacity: 0.65,
          fillOpacity: section.installed ? 0.025 : 0.01,
          dashArray: section.installed ? undefined : "3 5",
        },
      }).addTo(sectionGroup.current);
    }
  }, [ready, dataset.sections]);

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
      if (drawingRef.current) return;
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
    if (!map) return;
    changeDrawing(false);
    programmatic.current = true;
    map.fitBounds(leafletBounds(camera.bounds), {
      padding: [camera.padding ?? 40, camera.padding ?? 40],
      animate: false,
    });
    programmatic.current = false;
    if (camera.selectArea) callbacks.current.onViewport(visibleBounds(map));
  }, [camera]);
  useEffect(() => {
    if (!editing) changeDrawing(false);
  }, [editing]);
  useEffect(() => {
    if (locked || !movedWhileLocked.current) return;
    movedWhileLocked.current = false;
    if (editing && !drawn && instance.current)
      callbacks.current.onViewport(visibleBounds(instance.current));
  }, [locked]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") changeDrawing(false);
    };
    window.addEventListener("keydown", cancel);
    if (!drawing) {
      if (area) outline.current?.setBounds(leafletBounds(area));
      outline.current?.setStyle({
        opacity: area ? 1 : 0,
        fillOpacity: area ? 0.035 : 0,
      });
    } else if (!firstCorner.current)
      outline.current?.setStyle({ opacity: 0, fillOpacity: 0 });
    return () => window.removeEventListener("keydown", cancel);
  }, [drawing, area, ready]);

  return (
    <section
      className={`map-panel ${drawing ? "is-drawing" : ""}`}
      aria-label="Hike map"
    >
      <div className="map-canvas" ref={container} />
      {editing && (
        <div className="map-tools">
          <button
            type="button"
            disabled={!ready || locked}
            aria-pressed={drawing}
            onClick={() => changeDrawing(!drawing)}
          >
            {drawing
              ? "Cancel drawing"
              : drawn
                ? "Redraw area"
                : "Draw an area"}
          </button>
          {drawn && !drawing && (
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                if (instance.current)
                  onViewport(visibleBounds(instance.current));
              }}
            >
              Use map view
            </button>
          )}
        </div>
      )}
      {drawing && (
        <p className="map-notice" role="status">
          Click two opposite corners. Escape cancels.
        </p>
      )}
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
      {!drawing && (
        <span className="map-caption">
          {!editing && !!routes.length && "Dots mark starts on this page. "}
          Solid borders: downloaded trails. Dotted borders: available sections.
          {area && " The dashed rectangle selects starts; routes may extend beyond it."}
        </span>
      )}
    </section>
  );
}
