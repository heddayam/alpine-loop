import { useEffect, useRef, useState } from "react";
import {
  map as createMap,
  tileLayer,
  rectangle,
  polyline,
  layerGroup,
  circleMarker,
  DomEvent,
  type Map as LeafletMap,
  type Rectangle,
  type Polyline,
  type LayerGroup,
  type LatLngBoundsExpression,
} from "leaflet";
import type { Bounds, DatasetInfo, HikeRoute } from "../model.js";

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
  drawn,
  routes,
  selectedId,
  camera,
  onArea,
  onViewport,
  onDrawing,
  onSelect,
}: {
  dataset: DatasetInfo;
  area: Bounds | null;
  editing: boolean;
  drawn: boolean;
  routes: HikeRoute[];
  selectedId: string | null;
  camera: { bounds: Bounds; revision: number; selectArea?: boolean };
  onArea: (bounds: Bounds) => void;
  onViewport: (bounds: Bounds) => void;
  onDrawing: (drawing: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<LeafletMap | null>(null);
  const outline = useRef<Rectangle | null>(null);
  const routeGroup = useRef<LayerGroup | null>(null);
  const startGroup = useRef<LayerGroup | null>(null);
  const rendered = useRef(new Map<string, Polyline>());
  const callbacks = useRef({
    onArea,
    onViewport,
    onDrawing,
    onSelect,
    editing,
    drawn,
  });
  callbacks.current = {
    onArea,
    onViewport,
    onDrawing,
    onSelect,
    editing,
    drawn,
  };
  const programmatic = useRef(false);
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
    const map = createMap(container.current!, { preferCanvas: true });
    instance.current = map;
    map.zoomControl.setPosition("bottomright");
    map.fitBounds(leafletBounds(dataset.bounds), { padding: [30, 30] });
    tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
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
        !programmatic.current &&
        !drawingRef.current
      )
        callbacks.current.onViewport(visibleBounds(map));
    });
    map.on("click", (event) => {
      if (!drawingRef.current) return;
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
      rendered.current.clear();
      instance.current = null;
      outline.current = null;
      routeGroup.current = null;
      startGroup.current = null;
    };
  }, [dataset]);

  useEffect(() => {
    if (!ready || !routeGroup.current) return;
    const group = routeGroup.current;
    const ids = new Set(routes.map((route) => route.id));
    for (const [id, line] of rendered.current) {
      if (!ids.has(id)) {
        group.removeLayer(line);
        rendered.current.delete(id);
      }
    }
    for (const route of routes) {
      if (rendered.current.has(route.id)) continue;
      const line = polyline(
        route.geometry.map(([longitude, latitude]) => [latitude, longitude]),
        { color: "#315e49", weight: 4 },
      ).addTo(group);
      line.on("click", (event) => {
        if (drawingRef.current) return;
        DomEvent.stopPropagation(event.originalEvent);
        callbacks.current.onSelect(route.id);
      });
      rendered.current.set(route.id, line);
    }
    for (const [id, line] of rendered.current) {
      line.setStyle({
        color: id === selectedId ? "#b95b2c" : "#315e49",
        weight: id === selectedId ? 5 : 3,
        opacity: selectedId && id !== selectedId ? 0.25 : 0.85,
      });
      if (id === selectedId) line.bringToFront();
    }
    startGroup.current?.clearLayers();
    const start = routes.find((route) => route.id === selectedId)?.geometry[0];
    if (start && startGroup.current)
      circleMarker([start[1], start[0]], {
        radius: 6,
        color: "#b95b2c",
        weight: 2,
        fillColor: "white",
        fillOpacity: 1,
      })
        .bindTooltip("Start", { permanent: true, direction: "right" })
        .addTo(startGroup.current);
  }, [ready, routes, selectedId]);
  useEffect(() => {
    const map = instance.current;
    if (!map) return;
    if (camera.selectArea) changeDrawing(false);
    programmatic.current = true;
    map.fitBounds(leafletBounds(camera.bounds), {
      padding: [40, 40],
      animate: false,
    });
    programmatic.current = false;
    if (camera.selectArea) callbacks.current.onViewport(visibleBounds(map));
  }, [camera]);
  useEffect(() => {
    if (!editing) changeDrawing(false);
  }, [editing]);
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
            disabled={!ready}
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
      {area && !drawing && (
        <span className="map-caption">
          Dashed boundary selects starts. Routes may extend beyond it.
        </span>
      )}
    </section>
  );
}
