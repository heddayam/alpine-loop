"use client";

import { useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from "geojson";
import type { Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, GeoJSONSource, Marker as MapLibreMarker } from "maplibre-gl";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts";
import type { AccessPointOption, Bounds, FilterMode } from "../builder/types";
import { boundsContainBounds, boundsCorners, boundsDimensionsMiles, boundsPolygon, normalizeBounds } from "./geometry";
import { ROUTE_PREVIEW_EVENT } from "./routeTraceOverlay";

type HikeMapProps = {
  mode: FilterMode;
  drawBounds: Bounds | null;
  drawEnabled: boolean;
  filterGeometry?: Polygon | MultiPolygon;
  refinementGeometry?: Polygon | MultiPolygon;
  packCoverageBbox: Bounds;
  packCoverage: Polygon | MultiPolygon;
  suggestedBounds: Bounds;
  display: { center: [number, number]; zoom: number };
  trailNetwork: FeatureCollection<LineString>;
  accessPoints: AccessPointOption[];
  selectedAccessPointId?: string;
  routes: GeneratedClosedRouteV3[];
  selectedRouteId?: string;
  onBoundsChange: (bounds: Bounds | null) => void;
  onAccessPointSelect: (id: string) => void;
  onRouteSelect: (id: string) => void;
};

export type RouteTrailheadPin = {
  key: string;
  coordinates: [number, number];
  name: string;
  routeIds: string[];
  routeNumbers: number[];
  numberLabel: string;
  selected: boolean;
  nextRouteId: string;
};

export function showCoverageHatching(bounds: Bounds | null, drawing: boolean) {
  return !bounds || drawing;
}

export type MapStatusSummary = {
  boundary: "Draw mode" | "Drawing area" | "Area set" | "No area";
  dimensions?: string;
  coverage?: "Inside coverage" | "Outside coverage";
  accessPoints: string;
};

export function mapStatusSummary(
  bounds: Bounds | null,
  draftBounds: Bounds | null,
  drawing: boolean,
  packCoverage: Bounds,
  accessPointCount: number,
): MapStatusSummary {
  const statusBounds = draftBounds ?? (drawing ? null : bounds);
  const dimensions = statusBounds ? boundsDimensionsMiles(statusBounds) : null;
  const coverage = statusBounds
    ? boundsContainBounds(packCoverage, statusBounds) ? "Inside coverage" as const : "Outside coverage" as const
    : undefined;

  return {
    boundary: draftBounds
      ? "Drawing area"
      : drawing
        ? "Draw mode"
        : bounds
          ? "Area set"
          : "No area",
    ...(dimensions ? {
      dimensions: `${dimensions.width.toFixed(1)} × ${dimensions.height.toFixed(1)} mi (${dimensions.area.toFixed(1)} sq mi)`,
      coverage,
    } : {}),
    accessPoints: `${accessPointCount} access point${accessPointCount === 1 ? "" : "s"} available`,
  };
}

const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };

function areaFeature(geometry?: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> | FeatureCollection<Point> {
  return geometry ? { type: "Feature", properties: { role: "trailhead-filter" }, geometry } : EMPTY_POINTS;
}

function accessPointFeatures(accessPoints: AccessPointOption[], selectedAccessPointId?: string): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: accessPoints.map((point) => ({
      type: "Feature",
      properties: { id: point.id, name: point.name, selected: point.id === selectedAccessPointId },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
    })),
  };
}

export function routeFeatures(routes: GeneratedClosedRouteV3[], selectedRouteId?: string): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: routes.map((route, index) => ({
      type: "Feature",
      properties: {
        id: route.id,
        selected: route.id === selectedRouteId,
        routeNumber: index + 1,
        shape: route.topology.kind,
      },
      geometry: route.geometry,
    })),
  };
}

export function routeFeaturePartitions(
  routes: GeneratedClosedRouteV3[],
  selectedRouteId?: string,
  hoveredRouteId?: string,
) {
  return {
    all: routeFeatures(routes, selectedRouteId),
    alternates: routeFeatures(routes.filter((route) => route.id !== selectedRouteId), selectedRouteId),
    selected: routeFeatures(routes.filter((route) => route.id === selectedRouteId), selectedRouteId),
    hovered: routeFeatures(routes.filter((route) => route.id === hoveredRouteId), selectedRouteId),
  };
}

function numberLabel(numbers: number[]): string {
  if (numbers.length <= 4) return numbers.join("·");
  const consecutive = numbers.every((number, index) => index === 0 || number === numbers[index - 1]! + 1);
  return consecutive ? `${numbers[0]}–${numbers.at(-1)}` : `${numbers.slice(0, 3).join("·")}+${numbers.length - 3}`;
}

export function routeTrailheadPins(routes: GeneratedClosedRouteV3[], selectedRouteId?: string): RouteTrailheadPin[] {
  const groups = new Map<string, Omit<RouteTrailheadPin, "numberLabel" | "selected" | "nextRouteId">>();
  routes.forEach((route, index) => {
    const point = route.startAccessPoint;
    const firstCoordinate = route.geometry.coordinates[0];
    const coordinates: [number, number] = firstCoordinate
      ? [firstCoordinate[0], firstCoordinate[1]]
      : [point.lon, point.lat];
    const key = `${point.id}:${coordinates[0]}:${coordinates[1]}`;
    const existing = groups.get(key);
    if (existing) {
      existing.routeIds.push(route.id);
      existing.routeNumbers.push(index + 1);
      return;
    }
    groups.set(key, {
      key,
      coordinates,
      name: point.name,
      routeIds: [route.id],
      routeNumbers: [index + 1],
    });
  });

  return [...groups.values()].map((group) => {
    const selectedIndex = selectedRouteId ? group.routeIds.indexOf(selectedRouteId) : -1;
    return {
      ...group,
      numberLabel: numberLabel(group.routeNumbers),
      selected: selectedIndex >= 0,
      nextRouteId: selectedIndex >= 0
        ? group.routeIds[(selectedIndex + 1) % group.routeIds.length]!
        : group.routeIds[0]!,
    };
  });
}

export function HikeMap({
  mode,
  drawBounds: bounds,
  drawEnabled,
  filterGeometry,
  refinementGeometry,
  packCoverage,
  packCoverageBbox,
  suggestedBounds,
  display,
  trailNetwork,
  accessPoints,
  selectedAccessPointId,
  routes,
  selectedRouteId,
  onBoundsChange,
  onAccessPointSelect,
  onRouteSelect,
}: HikeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const routeMarkerConstructorRef = useRef<typeof import("maplibre-gl").Marker | null>(null);
  const routeMarkersRef = useRef<MapLibreMarker[]>([]);
  const startRef = useRef<[number, number] | null>(null);
  const draftBoundsRef = useRef<Bounds | null>(null);
  const boundsRef = useRef(bounds);
  const accessPointsRef = useRef(accessPoints);
  const trailNetworkRef = useRef(trailNetwork);
  const selectedAccessPointIdRef = useRef(selectedAccessPointId);
  const routesRef = useRef(routes);
  const selectedRouteIdRef = useRef(selectedRouteId);
  const filterGeometryRef = useRef(filterGeometry);
  const refinementGeometryRef = useRef(refinementGeometry);
  const [drawing, setDrawing] = useState(false);
  const [hoveredRouteId, setHoveredRouteId] = useState<string>();
  const [draftBounds, setDraftBounds] = useState<Bounds | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    accessPointsRef.current = accessPoints;
    selectedAccessPointIdRef.current = selectedAccessPointId;
  }, [accessPoints, selectedAccessPointId]);

  useEffect(() => {
    trailNetworkRef.current = trailNetwork;
    const source = mapRef.current?.getSource("trail-network") as GeoJSONSource | undefined;
    source?.setData(trailNetwork);
  }, [trailNetwork]);

  useEffect(() => {
    routesRef.current = routes;
    selectedRouteIdRef.current = selectedRouteId;
  }, [routes, selectedRouteId]);

  useEffect(() => {
    filterGeometryRef.current = filterGeometry;
    refinementGeometryRef.current = refinementGeometry;
  }, [filterGeometry, refinementGeometry]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let alive = true;
    let map: MapLibreMap | null = null;
    void import("maplibre-gl").then(({ Map, Marker, NavigationControl, setWorkerUrl }) => {
      if (!alive || !containerRef.current) return;
      setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
      routeMarkerConstructorRef.current = Marker;
      map = new Map({
        container: containerRef.current,
        bounds: [
          [packCoverageBbox[0], packCoverageBbox[1]],
          [packCoverageBbox[2], packCoverageBbox[3]],
        ],
        fitBoundsOptions: {
          padding: { top: 64, right: 44, bottom: 40, left: 44 },
          maxZoom: display.zoom,
        },
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            "usgs-topo": {
              type: "raster",
              tiles: [
                "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
              ],
              tileSize: 256,
              attribution: "USGS The National Map",
            },
          },
          layers: [{ id: "usgs-topo", type: "raster", source: "usgs-topo" }],
        },
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        const initialBounds = boundsRef.current;
        map?.addSource("pack-coverage", { type: "geojson", data: areaFeature(packCoverage) });
        map?.addLayer({
          id: "pack-coverage-fill",
          type: "fill",
          source: "pack-coverage",
          paint: { "fill-color": "#2a705a", "fill-opacity": 0.14 },
        });
        map?.addLayer({
          id: "pack-coverage-casing",
          type: "line",
          source: "pack-coverage",
          paint: { "line-color": "#fffaf0", "line-width": 7, "line-opacity": 0.9 },
        });
        map?.addLayer({
          id: "pack-coverage-line",
          type: "line",
          source: "pack-coverage",
          paint: { "line-color": "#17604b", "line-width": 4, "line-dasharray": [3, 2] },
        });
        map?.addSource("trailhead-filter", { type: "geojson", data: filterGeometryRef.current ? areaFeature(filterGeometryRef.current) : initialBounds ? boundsPolygon(initialBounds) : EMPTY_POINTS });
        map?.addLayer({
          id: "trailhead-filter-fill",
          type: "fill",
          source: "trailhead-filter",
          paint: { "fill-color": "#2f6f9f", "fill-opacity": 0.18 },
        });
        map?.addLayer({
          id: "trailhead-filter-casing",
          type: "line",
          source: "trailhead-filter",
          paint: { "line-color": "#fffaf0", "line-width": 8, "line-opacity": 0.95 },
        });
        map?.addLayer({
          id: "trailhead-filter-line",
          type: "line",
          source: "trailhead-filter",
          paint: { "line-color": "#24587f", "line-width": 4, "line-dasharray": [1, 1.5] },
        });
        map?.addSource("region-refinement", { type: "geojson", data: areaFeature(refinementGeometryRef.current) });
        map?.addLayer({ id: "region-refinement-fill", type: "fill", source: "region-refinement", paint: { "fill-color": "#8e4f8f", "fill-opacity": 0.13 } });
        map?.addLayer({ id: "region-refinement-casing", type: "line", source: "region-refinement", paint: { "line-color": "#fffaf0", "line-width": 7, "line-opacity": 0.95 } });
        map?.addLayer({ id: "region-refinement-line", type: "line", source: "region-refinement", paint: { "line-color": "#713e78", "line-width": 3.5, "line-dasharray": [4, 1, 1, 1] } });
        map?.addSource("boundary-preview", { type: "geojson", data: EMPTY_POINTS });
        map?.addLayer({
          id: "boundary-preview-fill",
          type: "fill",
          source: "boundary-preview",
          paint: { "fill-color": "#4f91c2", "fill-opacity": 0.25 },
        });
        map?.addLayer({
          id: "boundary-preview-casing",
          type: "line",
          source: "boundary-preview",
          paint: { "line-color": "#fffaf0", "line-width": 7, "line-opacity": 0.95 },
        });
        map?.addLayer({
          id: "boundary-preview-line",
          type: "line",
          source: "boundary-preview",
          paint: { "line-color": "#24587f", "line-width": 4, "line-dasharray": [2, 1] },
        });
        map?.addSource("boundary-preview-corners", { type: "geojson", data: EMPTY_POINTS });
        map?.addLayer({
          id: "boundary-preview-corners",
          type: "circle",
          source: "boundary-preview-corners",
          paint: {
            "circle-radius": 6,
            "circle-color": "#4f91c2",
            "circle-stroke-color": "#fffaf0",
            "circle-stroke-width": 3,
          },
        });
        map?.addSource("trail-network", { type: "geojson", data: trailNetworkRef.current });
        map?.addLayer({
          id: "trail-network-casing",
          type: "line",
          source: "trail-network",
          paint: { "line-color": "#fffaf0", "line-width": 8, "line-opacity": 0.92 },
        });
        map?.addLayer({
          id: "trail-network-lines",
          type: "line",
          source: "trail-network",
          paint: { "line-color": "#314e43", "line-width": 3.5, "line-opacity": 1, "line-dasharray": [1.5, 1] },
        });
        map?.addSource("access-points", {
          type: "geojson",
          data: accessPointFeatures(accessPointsRef.current, selectedAccessPointIdRef.current),
        });
        map?.addLayer({
          id: "access-points",
          type: "circle",
          source: "access-points",
          paint: {
            "circle-radius": ["case", ["==", ["get", "selected"], true], 9, 6],
            "circle-color": ["case", ["==", ["get", "selected"], true], "#ed7b4f", "#173f35"],
            "circle-stroke-color": "#fffaf0",
            "circle-stroke-width": 2,
          },
        });
        map?.addSource("generated-routes-hit", {
          type: "geojson",
          data: routeFeaturePartitions(routesRef.current, selectedRouteIdRef.current).all,
        });
        map?.addSource("generated-route-alternates", {
          type: "geojson",
          data: routeFeaturePartitions(routesRef.current, selectedRouteIdRef.current).alternates,
        });
        map?.addSource("generated-route-selected", {
          type: "geojson",
          data: routeFeaturePartitions(routesRef.current, selectedRouteIdRef.current).selected,
        });
        map?.addSource("generated-route-hover", {
          type: "geojson",
          data: EMPTY_LINES,
        });
        map?.addLayer({
          id: "generated-route-alternate-casing",
          type: "line",
          source: "generated-route-alternates",
          paint: { "line-color": "#18312a", "line-width": 7, "line-opacity": 0.8, "line-dasharray": [2, 1.5] },
        });
        map?.addLayer({
          id: "generated-route-alternates",
          type: "line",
          source: "generated-route-alternates",
          paint: { "line-color": "#fffaf0", "line-width": 3, "line-opacity": 0.95, "line-dasharray": [2, 3.5] },
        });
        map?.addLayer({
          id: "generated-route-selected-casing",
          type: "line",
          source: "generated-route-selected",
          paint: { "line-color": "#173f35", "line-width": 12, "line-opacity": 0.98 },
        });
        map?.addLayer({
          id: "generated-route-selected",
          type: "line",
          source: "generated-route-selected",
          paint: { "line-color": "#f47b4d", "line-width": 8 },
        });
        map?.addLayer({
          id: "generated-route-hover-casing",
          type: "line",
          source: "generated-route-hover",
          paint: { "line-color": "#173f35", "line-width": 12, "line-opacity": 0.98 },
        });
        map?.addLayer({
          id: "generated-route-hover",
          type: "line",
          source: "generated-route-hover",
          paint: { "line-color": "#fff0a8", "line-width": 7, "line-dasharray": [3, 1] },
        });
        map?.addLayer({
          id: "generated-route-hit-target",
          type: "line",
          source: "generated-routes-hit",
          paint: { "line-color": "#000000", "line-width": 20, "line-opacity": 0.01 },
        });
        const selectRoute = (event: MapLayerMouseEvent) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onRouteSelect(id);
        };
        map?.on("click", "generated-route-alternates", selectRoute);
        map?.on("click", "generated-route-selected", selectRoute);
        map?.on("click", "generated-route-hit-target", selectRoute);
        map?.on("mouseenter", "generated-route-hit-target", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          map?.getCanvas().style.setProperty("cursor", "pointer");
          setHoveredRouteId(id);
        });
        map?.on("mouseleave", "generated-route-hit-target", () => {
          map?.getCanvas().style.removeProperty("cursor");
          setHoveredRouteId(undefined);
        });
        map?.on("click", "access-points", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onAccessPointSelect(id);
        });
        setMapReady(true);
      });
    });
    return () => {
      alive = false;
      routeMarkersRef.current.forEach((marker) => marker.remove());
      routeMarkersRef.current = [];
      map?.remove();
      mapRef.current = null;
      routeMarkerConstructorRef.current = null;
    };
  }, [display.center, display.zoom, onAccessPointSelect, onRouteSelect, packCoverage, packCoverageBbox]);

  useEffect(() => {
    const source = mapRef.current?.getSource("trailhead-filter") as GeoJSONSource | undefined;
    source?.setData(areaFeature(filterGeometry));
    const refinementSource = mapRef.current?.getSource("region-refinement") as GeoJSONSource | undefined;
    refinementSource?.setData(areaFeature(refinementGeometry));
  }, [filterGeometry, refinementGeometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer("pack-coverage-fill")) return;
    map.setPaintProperty("pack-coverage-fill", "fill-opacity", showCoverageHatching(filterGeometry ? bounds : null, drawing) ? 0.14 : 0.055);
  }, [bounds, drawing, filterGeometry, mapReady]);

  useEffect(() => {
    const source = mapRef.current?.getSource("access-points") as GeoJSONSource | undefined;
    source?.setData(accessPointFeatures(accessPoints, selectedAccessPointId));
  }, [accessPoints, selectedAccessPointId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const partitions = routeFeaturePartitions(routes, selectedRouteId, hoveredRouteId);
    (map.getSource("generated-routes-hit") as GeoJSONSource | undefined)?.setData(partitions.all);
    (map.getSource("generated-route-alternates") as GeoJSONSource | undefined)?.setData(partitions.alternates);
    (map.getSource("generated-route-selected") as GeoJSONSource | undefined)?.setData(partitions.selected);
    (map.getSource("generated-route-hover") as GeoJSONSource | undefined)?.setData(partitions.hovered);
  }, [hoveredRouteId, mapReady, routes, selectedRouteId]);

  useEffect(() => {
    const handleRoutePreview = (event: Event) => {
      const routeId = (event as CustomEvent<{ routeId?: string }>).detail?.routeId;
      setHoveredRouteId(routeId);
    };
    window.addEventListener(ROUTE_PREVIEW_EVENT, handleRoutePreview);
    return () => window.removeEventListener(ROUTE_PREVIEW_EVENT, handleRoutePreview);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const Marker = routeMarkerConstructorRef.current;
    if (!map || !Marker || !mapReady) return;

    routeMarkersRef.current.forEach((marker) => marker.remove());
    const starts = routeTrailheadPins(routes, selectedRouteId);
    routeMarkersRef.current = starts.map((pin) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = [
        "route-trailhead-pin",
        "start",
        pin.selected ? "selected" : "",
        pin.numberLabel.length > 4 ? "dense" : "",
      ].filter(Boolean).join(" ");
      element.dataset.routeCount = String(pin.routeIds.length);
      const routeDescription = pin.routeNumbers.length === 1
        ? `route ${pin.routeNumbers[0]}`
        : `routes ${pin.routeNumbers.join(", ")}`;
      element.setAttribute("aria-label", `${pin.name}, ${routeDescription}${pin.selected ? ", selected" : ""}`);
      element.title = `${pin.name} · ${routeDescription}${pin.routeIds.length > 1 ? " · click to cycle matches" : ""}`;

      const shape = document.createElement("span");
      shape.className = "route-trailhead-pin-shape";
      const label = document.createElement("span");
      label.className = "route-trailhead-pin-number";
      label.textContent = pin.numberLabel;
      shape.append(label);
      element.append(shape);
      const stem = document.createElement("span");
      stem.className = "route-trailhead-pin-stem";
      const anchor = document.createElement("span");
      anchor.className = "route-trailhead-pin-anchor";
      const caption = document.createElement("span");
      caption.className = "route-trailhead-pin-caption";
      caption.textContent = "Start";
      element.append(stem, anchor, caption);
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onRouteSelect(pin.nextRouteId);
      });
      element.addEventListener("mouseenter", () => setHoveredRouteId(pin.nextRouteId));
      element.addEventListener("mouseleave", () => setHoveredRouteId(undefined));
      element.addEventListener("focus", () => setHoveredRouteId(pin.nextRouteId));
      element.addEventListener("blur", () => setHoveredRouteId(undefined));

      return new Marker({ element, anchor: "bottom" }).setLngLat(pin.coordinates).addTo(map);
    });

    return () => {
      routeMarkersRef.current.forEach((marker) => marker.remove());
      routeMarkersRef.current = [];
    };
  }, [mapReady, onRouteSelect, routes, selectedRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !drawing || !drawEnabled) return;
    const previewSource = map.getSource("boundary-preview") as GeoJSONSource | undefined;
    const cornerSource = map.getSource("boundary-preview-corners") as GeoJSONSource | undefined;
    const clearPreview = () => {
      previewSource?.setData(EMPTY_POINTS);
      cornerSource?.setData(EMPTY_POINTS);
      draftBoundsRef.current = null;
      setDraftBounds(null);
    };
    const handleDown = (event: MapMouseEvent) => {
      event.preventDefault();
      startRef.current = [event.lngLat.lng, event.lngLat.lat];
      map.dragPan.disable();
    };
    const handleMove = (event: MapMouseEvent) => {
      if (!startRef.current) return;
      const next = normalizeBounds(startRef.current, [event.lngLat.lng, event.lngLat.lat]);
      if (!next) return;
      previewSource?.setData(boundsPolygon(next));
      cornerSource?.setData(boundsCorners(next));
      draftBoundsRef.current = next;
      setDraftBounds(next);
    };
    const finishDrawing = (next: Bounds | null) => {
      if (!startRef.current) return;
      startRef.current = null;
      map.dragPan.enable();
      setDrawing(false);
      clearPreview();
      if (next) onBoundsChange(next);
    };
    const handleUp = (event: MapMouseEvent) => {
      if (!startRef.current) return;
      finishDrawing(normalizeBounds(startRef.current, [event.lngLat.lng, event.lngLat.lat]));
    };
    const handleWindowUp = () => finishDrawing(draftBoundsRef.current);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      startRef.current = null;
      map.dragPan.enable();
      clearPreview();
      setDrawing(false);
    };
    map.getCanvas().style.cursor = "crosshair";
    map.on("mousedown", handleDown);
    map.on("mousemove", handleMove);
    map.on("mouseup", handleUp);
    window.addEventListener("mouseup", handleWindowUp);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      map.off("mousedown", handleDown);
      map.off("mousemove", handleMove);
      map.off("mouseup", handleUp);
      window.removeEventListener("mouseup", handleWindowUp);
      window.removeEventListener("keydown", handleKeyDown);
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      startRef.current = null;
      clearPreview();
    };
  }, [drawEnabled, drawing, mapReady, onBoundsChange]);

  const mapStatus = mapStatusSummary(bounds, draftBounds, drawing, packCoverageBbox, accessPoints.length);

  return (
    <section className={drawing ? "map-shell is-drawing" : "map-shell"} aria-label="Hike search map">
      {drawEnabled ? <div className="map-toolbar map-toolbar-compact" role="toolbar" aria-label="Draw-area tools">
        <button
          type="button"
          className={`map-tool map-tool-draw${drawing ? " active" : ""}`}
          aria-label={bounds ? "Redraw trailhead filter" : "Draw trailhead filter"}
          aria-pressed={drawing}
          onClick={() => setDrawing(true)}
        >
          {bounds ? "Redraw" : "Draw area"}
        </button>
        <button type="button" className="map-tool map-tool-demo" aria-label="Use demo trailhead filter" onClick={() => {
          onBoundsChange([...suggestedBounds]);
          mapRef.current?.fitBounds(
            [[suggestedBounds[0], suggestedBounds[1]], [suggestedBounds[2], suggestedBounds[3]]],
            { padding: 48, duration: 350 },
          );
        }}>
          Demo
        </button>
        <button type="button" className="map-tool map-tool-clear" aria-label="Clear trailhead filter" disabled={!bounds} onClick={() => onBoundsChange(null)}>
          Clear
        </button>
      </div> : null}
      <div ref={containerRef} className="map-canvas" aria-hidden="true" />
      <output className="map-status" aria-label="Map status">
        <span className="map-status-boundary">{mode === "drawn-area" ? mapStatus.boundary : mode === "named-region" ? "Named region" : "Drive time"}</span>
        {mapStatus.dimensions ? <span className="map-status-dimensions">{mapStatus.dimensions}</span> : null}
        {mapStatus.coverage ? <span className="map-status-coverage">{mapStatus.coverage}</span> : null}
        <span className="map-status-access">{mapStatus.accessPoints}</span>
      </output>
      <details className="map-key map-key-collapsible">
        <summary className="map-key-toggle">Map key</summary>
        <div className="map-key-content" aria-label="Map symbol explanations">
          <span><i className="key-coverage" aria-hidden="true" />Installed coverage</span>
          {filterGeometry ? <span><i className="key-filter" aria-hidden="true" />Trailhead filter</span> : null}
          {refinementGeometry ? <span><i className="key-refinement" aria-hidden="true" />Named refinement</span> : null}
          {accessPoints.length > 0 ? <span><i className="key-access" aria-hidden="true" />Eligible access</span> : null}
          <span><i className="key-trail" aria-hidden="true" />Mapped trail</span>
          {routes.length > 0 ? <span><i className="key-route" aria-hidden="true" />Suggested route</span> : null}
          {routes.length > 0 ? <span><i className="key-start" aria-hidden="true" />Route start</span> : null}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" aria-label="OpenStreetMap attribution">© OpenStreetMap contributors</a>
        </div>
      </details>
      <p className="map-hint">
        {drawing
          ? "Draw a trailhead filter. It may extend beyond installed coverage."
          : filterGeometry
            ? "Highlighted areas filter trailheads, not route geometry. Routes remain inside installed coverage."
            : mode === "drawn-area"
              ? "Draw an area or use keyboard coordinates to filter trailheads."
              : "Complete the selected trailhead filter to preview eligible access."}
      </p>
    </section>
  );
}
