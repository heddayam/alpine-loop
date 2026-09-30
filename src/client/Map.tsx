import { useEffect, useRef, useState } from "react";
import {
  map as createMap,
  tileLayer,
  rectangle,
  polyline,
  layerGroup,
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

export function HikeMap({
  dataset,
  area,
  routes,
  selectedId,
  camera,
  onArea,
  onSelect,
}: {
  dataset: DatasetInfo;
  area: Bounds | null;
  routes: HikeRoute[];
  selectedId: string | null;
  camera: { bounds: Bounds; revision: number };
  onArea: (bounds: Bounds) => void;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<LeafletMap | null>(null);
  const outline = useRef<Rectangle | null>(null);
  const routeGroup = useRef<LayerGroup | null>(null);
  const rendered = useRef(new Map<string, Polyline>());
  const callbacks = useRef({ onArea, onSelect });
  callbacks.current = { onArea, onSelect };
  const [ready, setReady] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  const firstCorner = useRef<[number, number] | null>(null);

  useEffect(() => {
    const map = createMap(container.current!, {
      preferCanvas: true,
      zoomControl: false,
    });
    instance.current = map;
    map.fitBounds(leafletBounds(dataset.bounds), { padding: [30, 30] });
    tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    outline.current = rectangle(leafletBounds(dataset.bounds), {
      color: "#315e49",
      weight: 2,
      dashArray: "6 5",
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(map);
    routeGroup.current = layerGroup().addTo(map);
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
      firstCorner.current = null;
      drawingRef.current = false;
      setDrawing(false);
    });
    map.on("mousemove", (event) => {
      if (!drawingRef.current || !firstCorner.current) return;
      const [longitude, latitude] = firstCorner.current;
      outline.current?.setBounds([
        [latitude, longitude],
        [event.latlng.lat, event.latlng.lng],
      ]);
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
    };
  }, [dataset]);

  useEffect(() => {
    if (!ready || !instance.current || !routeGroup.current) return;
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
        {
          color: "#315e49",
          weight: 4,
          opacity: 0.75,
        },
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
        weight: id === selectedId ? 6 : 4,
        opacity: selectedId && id !== selectedId ? 0.35 : 0.85,
      });
      if (id === selectedId) line.bringToFront();
    }
  }, [ready, routes, selectedId]);
  useEffect(() => {
    instance.current?.fitBounds(leafletBounds(camera.bounds), {
      padding: [40, 40],
      animate: false,
    });
  }, [camera]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        firstCorner.current = null;
        drawingRef.current = false;
        setDrawing(false);
      }
    };
    window.addEventListener("keydown", cancel);
    if (!drawing && area) outline.current?.setBounds(leafletBounds(area));
    return () => window.removeEventListener("keydown", cancel);
  }, [drawing, area, ready]);

  return (
    <section
      className={`map-panel ${drawing ? "is-drawing" : ""}`}
      aria-label="Hike map"
    >
      <div className="map-canvas" ref={container} />
      <div className="map-tools">
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            const bounds = instance.current!.getBounds();
            callbacks.current.onArea([
              bounds.getWest(),
              bounds.getSouth(),
              bounds.getEast(),
              bounds.getNorth(),
            ]);
          }}
        >
          Use visible area
        </button>
        <button
          type="button"
          disabled={!ready}
          aria-pressed={drawing}
          onClick={() => {
            firstCorner.current = null;
            drawingRef.current = !drawing;
            setDrawing(!drawing);
          }}
        >
          {drawing ? "Cancel drawing" : "Draw an area"}
        </button>
      </div>
      <div className="map-zoom" aria-label="Map zoom">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => instance.current?.zoomIn()}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => instance.current?.zoomOut()}
        >
          −
        </button>
      </div>
      {drawing && (
        <p className="map-notice" role="status">
          Click two opposite corners. Escape cancels.
        </p>
      )}
      <span className="map-caption">
        Area selects starting points. Hikes may extend beyond it.
      </span>
    </section>
  );
}
