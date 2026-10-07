import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { boundaryError, boundaryGeometry, MAX_BOUNDARY_VERTICES } from "../boundary.js";
import type { SearchBoundary } from "../model.js";

const empty: FeatureCollection = { type: "FeatureCollection", features: [] };

export function BoundaryDrawing({ map, onFinish, onCancel }: {
  map: MapLibreMap | null;
  onFinish: (boundary: SearchBoundary) => string | null;
  onCancel: () => void;
}) {
  const [points, setPoints] = useState<SearchBoundary>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [error, setError] = useState("");
  const latest = useRef({ points, onCancel, finish: () => {} });
  const finish = () => {
    const problem = boundaryError(points) ?? onFinish(points);
    if (problem) setError(problem);
  };
  latest.current = { points, onCancel, finish };

  useEffect(() => {
    if (!map) return;
    map.addSource("boundary-draft", { type: "geojson", data: empty });
    map.addLayer({ id: "boundary-draft-fill", type: "fill", source: "boundary-draft",
      filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#557f9b", "fill-opacity": 0.12 } });
    map.addLayer({ id: "boundary-draft-line", type: "line", source: "boundary-draft",
      filter: ["==", "$type", "LineString"], paint: { "line-color": "#557f9b", "line-width": 2, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "boundary-draft-points", type: "circle", source: "boundary-draft",
      filter: ["==", "$type", "Point"], paint: { "circle-color": "#fff", "circle-radius": 5,
        "circle-stroke-color": "#557f9b", "circle-stroke-width": 2 } });
    const zoomOnDoubleClick = map.doubleClickZoom.isEnabled();
    const keyboardEnabled = map.keyboard.isEnabled();
    map.doubleClickZoom.disable();
    map.keyboard.disable();
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    canvas.focus();
    const click = (event: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
      const vertices = latest.current.points;
      if (vertices.length >= 3) {
        const first = map.project(vertices[0]!);
        if (Math.hypot(event.point.x - first.x, event.point.y - first.y) <= 10) {
          latest.current.finish();
          return;
        }
      }
      if (vertices.length === MAX_BOUNDARY_VERTICES) {
        setError(`Use up to ${MAX_BOUNDARY_VERTICES} points. Finish or undo a point.`);
        return;
      }
      const point: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      if (vertices.at(-1)?.every((value, index) => value === point[index])) return;
      setPoints(current => [...current, point]);
      setCursor(null);
      setError("");
    };
    const move = (event: { lngLat: { lng: number; lat: number } }) => {
      if (!map.isMoving()) setCursor([event.lngLat.lng, event.lngLat.lat]);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        latest.current.onCancel();
      } else if (event.target === canvas && event.key === "Enter") {
        event.preventDefault();
        latest.current.finish();
      } else if (event.target === canvas && (event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        setPoints(current => current.slice(0, -1));
        setError("");
      }
    };
    map.on("click", click);
    map.on("mousemove", move);
    document.addEventListener("keydown", key);
    return () => {
      map.off("click", click);
      map.off("mousemove", move);
      document.removeEventListener("keydown", key);
      if (zoomOnDoubleClick) map.doubleClickZoom.enable();
      if (keyboardEnabled) map.keyboard.enable();
      canvas.style.cursor = "";
      for (const id of ["boundary-draft-points", "boundary-draft-line", "boundary-draft-fill"])
        if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource("boundary-draft")) map.removeSource("boundary-draft");
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const vertices = cursor && points.length ? [...points, cursor] : points;
    const features: FeatureCollection["features"] = points.map(point => ({
      type: "Feature", properties: {}, geometry: { type: "Point", coordinates: point },
    }));
    if (vertices.length >= 2) features.push({ type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: vertices.length >= 3 ? [...vertices, vertices[0]!] : vertices } });
    if (vertices.length >= 3) features.push({ type: "Feature", properties: {}, geometry: boundaryGeometry(vertices) });
    (map.getSource("boundary-draft") as GeoJSONSource).setData({ type: "FeatureCollection", features });
  }, [map, points, cursor]);

  return (
    <div className="boundary-toolbar" aria-label="Draw search boundary">
      <strong>Draw boundary</strong>
      <p role="status">{!map ? "Opening map…" : points.length < 3
        ? "Click the map to add points."
        : "Click Finish or the first point to close."}</p>
      {error && <p className="boundary-error" role="alert">{error}</p>}
      <div className="boundary-actions">
        <button
          type="button"
          className="primary"
          disabled={points.length < 3 || !map}
          title={points.length < 3 ? "Add at least 3 points to finish" : "Finish drawing (Enter)"}
          aria-label="Finish"
          aria-keyshortcuts="Enter"
          onClick={finish}
        >Finish <kbd aria-hidden="true">Enter</kbd></button>
        <button
          type="button"
          disabled={!points.length}
          title="Remove the last point (Backspace or Delete)"
          aria-label="Undo"
          aria-keyshortcuts="Backspace Delete"
          onClick={() => { setPoints(current => current.slice(0, -1)); setError(""); }}
        >Undo <kbd aria-hidden="true">Backspace</kbd></button>
        <button
          type="button"
          className="text-button"
          title="Cancel drawing (Esc)"
          aria-label="Cancel"
          aria-keyshortcuts="Escape"
          onClick={onCancel}
        ><span>Cancel</span> <kbd aria-hidden="true">Esc</kbd></button>
      </div>
    </div>
  );
}
