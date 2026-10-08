import { useEffect, useRef } from "react";
import { Marker, type Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";
import type { RouteLocation } from "../model.js";
import { startPoints } from "./clusters.js";

type Props = {
  map: MapLibreMap | null;
  routes: RouteLocation[];
  selectedId: string | null;
  previewId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  onBrowse: (ids: string[]) => void;
  onInspect: (name: string | null) => void;
};
type Point = { key: string; position: [number, number] } & (
  | { kind: "start"; route: RouteLocation }
  | { kind: "shared"; routes: RouteLocation[] }
  | { kind: "cluster"; clusterId: number; count: number; leaves: number }
);
type Entry = { marker: Marker; point: Point; hovered: boolean; focused: boolean };
const SOURCE = "hike-starts";

/** Browsing clusters nearby starts. Inspecting shows only the selected hike at its exact start. */
export function HikeMarkers(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const entries = useRef(new Map<string, Entry>());
  const refresh = useRef<() => void>(() => {});
  const paint = ({ marker, point }: Entry) => {
    const button = marker.getElement(), symbol = button.firstElementChild as HTMLElement;
    const selected = point.kind === "start" && point.route.id === latest.current.selectedId;
    const previewed = point.kind === "start" && point.route.id === latest.current.previewId;
    button.classList.toggle("hike-marker--start", point.kind === "start");
    button.classList.toggle("hike-marker--group", point.kind !== "start");
    button.dataset.state = selected ? "selected" : previewed ? "preview" : "idle";
    if (point.kind === "start") {
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `${selected ? "Selected hike start" : "Select hike"}: ${point.route.startName || "Unnamed start"}`);
      symbol.textContent = "";
      button.style.removeProperty("--marker-size");
    } else {
      const count = point.kind === "cluster" ? point.count : point.routes.length;
      button.removeAttribute("aria-pressed");
      button.setAttribute("aria-label", `${point.kind === "cluster" ? "Zoom to" : "Browse"} ${count} hikes`);
      symbol.textContent = count.toLocaleString();
      button.style.setProperty("--marker-size", `${Math.max(22, 8 + symbol.textContent.length * 7)}px`);
    }
  };
  useEffect(() => {
    for (const entry of entries.current.values()) paint(entry);
    refresh.current();
  }, [props.selectedId, props.previewId]);

  useEffect(() => {
    const { map, routes, disabled, selectedId } = props;
    if (!map || disabled) return;
    const starts = new Map(startPoints(routes, selectedId).map(point => [point.key, point]));
    const routesById = new Map(routes.map(route => [route.id, route]));
    let disposed = false, action = 0;
    map.addSource(SOURCE, {
      type: "geojson", cluster: !selectedId, clusterRadius: 40, clusterMaxZoom: 18, clusterMinPoints: 2,
      clusterProperties: { hike_count: ["+", ["get", "hike_count"]] },
      data: {
        type: "FeatureCollection",
        features: [...starts.values()].map(point => ({
          type: "Feature", properties: { key: point.key, hike_count: point.routes.length },
          geometry: { type: "Point", coordinates: point.position },
        })),
      },
    });
    // A source needs a visible layer to load; accessible HTML buttons provide the drawing.
    map.addLayer({ id: SOURCE, type: "circle", source: SOURCE,
      paint: { "circle-radius": 0, "circle-opacity": 0 } });
    const source = map.getSource(SOURCE) as GeoJSONSource;
    const inspect = (entry?: Entry) => {
      const point = entry && (entry.hovered || entry.focused) ? entry.point : undefined;
      const route = point?.kind === "start" ? point.route : undefined;
      latest.current.onInspect(route?.startName || null);
      latest.current.onPreview(route && route.id !== latest.current.selectedId ? route.id : null);
    };
    const clear = () => {
      action++;
      for (const entry of entries.current.values()) entry.hovered = entry.focused = false;
      inspect();
    };
    const activate = async (point: Point) => {
      clear();
      const request = ++action;
      if (point.kind === "start") latest.current.onSelect(point.route.id);
      else if (point.kind === "shared") latest.current.onBrowse(point.routes.map(route => route.id));
      else {
        try {
          const zoom = await source.getClusterExpansionZoom(point.clusterId);
          if (disposed || request !== action) return;
          if (zoom <= map.getMaxZoom()) map.easeTo({ center: point.position,
            zoom: Math.min(zoom + 0.5, map.getMaxZoom()), duration: 250 });
          else {
            const leaves = await source.getClusterLeaves(point.clusterId, point.leaves, 0);
            if (disposed || request !== action) return;
            latest.current.onBrowse(leaves.flatMap(leaf => starts.get(String(leaf.properties?.key))?.routes.map(route => route.id) ?? []));
          }
        } catch {
          // Source replacement or a new camera gesture can invalidate a cluster click.
        }
      }
    };
    const draw = () => {
      if (disposed || map.isMoving() || !map.isSourceLoaded(SOURCE)) return;
      const bounds = map.getBounds(), visible = new Set<string>();
      const points: Point[] = [];
      for (const feature of map.querySourceFeatures(SOURCE)) {
        if (feature.geometry.type !== "Point") continue;
        const position = feature.geometry.coordinates as [number, number];
        const properties = feature.properties;
        let point: Point;
        if (properties.cluster) point = { kind: "cluster", key: `cluster:${properties.cluster_id}`,
          position, clusterId: properties.cluster_id, count: properties.hike_count, leaves: properties.point_count };
        else {
          const start = starts.get(String(properties.key));
          if (!start) continue;
          point = start.routes.length === 1
            ? { kind: "start", key: start.key, position: start.position, route: start.routes[0]! }
            : { kind: "shared", key: start.key, position: start.position, routes: start.routes };
        }
        points.push(point);
      }
      const preview = latest.current.previewId ? routesById.get(latest.current.previewId) : undefined;
      if (preview && preview.id !== selectedId
        && !points.some(point => point.kind === "start" && point.route.id === preview.id)) {
        const position: [number, number] = [preview.startPosition[0], preview.startPosition[1]];
        // An exact preview takes the place of a shared-start count while inspected.
        const samePosition = (point: Point) => point.position[0] === position[0] && point.position[1] === position[1];
        if (!points.some(point => point.kind === "start" && samePosition(point))) {
          for (let index = points.length - 1; index >= 0; index--)
            if (samePosition(points[index]!)) points.splice(index, 1);
          points.push({ kind: "start", key: `preview:${preview.id}`, route: preview, position });
        }
      }
      for (const point of points) {
        if (!bounds.contains(point.position) || visible.has(point.key)) continue;
        visible.add(point.key);
        let entry = entries.current.get(point.key);
        if (!entry) {
          const button = document.createElement("button"), symbol = document.createElement("span");
          button.type = "button";
          button.className = "hike-marker";
          symbol.className = "hike-marker-symbol";
          symbol.setAttribute("aria-hidden", "true");
          button.append(symbol);
          const created: Entry = { marker: new Marker({ element: button }), point, hovered: false, focused: false };
          button.addEventListener("pointerenter", () => { created.hovered = true; inspect(created); });
          button.addEventListener("pointerleave", () => { created.hovered = false; inspect(created); });
          button.addEventListener("focus", () => { created.focused = button.matches(":focus-visible"); inspect(created); });
          button.addEventListener("blur", () => { created.focused = false; inspect(created); });
          button.addEventListener("click", event => { event.stopPropagation(); void activate(created.point); });
          entry = created;
          entries.current.set(point.key, entry);
          entry.marker.setLngLat(point.position).addTo(map);
          paint(entry);
        }
        const previousPosition = entry.point.position;
        entry.point = point;
        if (previousPosition[0] !== point.position[0] || previousPosition[1] !== point.position[1])
          entry.marker.setLngLat(point.position);
      }
      for (const [key, entry] of entries.current) if (!visible.has(key)) {
        if (entry.hovered || entry.focused) inspect();
        entry.marker.remove();
        entries.current.delete(key);
      }
    };
    // Follow MapLibre's HTML-cluster pattern: query after the current source tiles render.
    map.on("render", draw);
    map.on("movestart", clear);
    draw();
    refresh.current = draw;
    return () => {
      disposed = true;
      refresh.current = () => {};
      map.off("render", draw);
      map.off("movestart", clear);
      for (const entry of entries.current.values()) entry.marker.remove();
      entries.current.clear();
      if (map.getStyle()) { map.removeLayer(SOURCE); map.removeSource(SOURCE); }
      clear();
    };
  }, [props.map, props.routes, props.disabled, props.selectedId]);
  return null;
}
