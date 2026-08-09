"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from "geojson";
import type { DataDrivenPropertyValueSpecification, FilterSpecification, Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, GeoJSONSource, Marker } from "maplibre-gl";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts";
import type { AccessPointOption, Bounds } from "../builder/types";
import { boundsCorners, boundsPolygon, normalizeBounds } from "./geometry";
import { ROUTE_PREVIEW_EVENT } from "./routeTraceOverlay";

type HikeMapProps = {
  packId: string;
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
  selectedSegmentId?: string;
  hoveredSegmentId?: string;
  onBoundsChange: (bounds: Bounds | null) => void;
  onAccessPointSelect: (id: string) => void;
  onRouteSelect: (id: string) => void;
  onRouteHover?: (id?: string) => void;
  onSegmentSelect?: (id: string) => void;
  onSegmentHover?: (id?: string) => void;
};

/* One hue per meaning: orange is the selection and nothing else, green is
   every unselected route, white is the casing that lifts both off the topo. */
const ROUTE_SELECTED = "#c9552a";
const ROUTE_ALTERNATE = "#2f6a55";
const CASING = "#ffffff";
export const TRAIL_NETWORK_MIN_ZOOM = 11;
const EMPTY_TRAIL_HOVER_FILTER: FilterSpecification = ["==", ["get", "trailGroupId"], "__none__"];

export function trailNetworkHoverFilter(id?: string): FilterSpecification {
  return id ? ["==", ["get", "trailGroupId"], id] : EMPTY_TRAIL_HOVER_FILTER;
}

export function trailNetworkRequestUrl(packId: string, bounds: Bounds, zoom: number): string | undefined {
  if (zoom < TRAIL_NETWORK_MIN_ZOOM) return undefined;
  const query = new URLSearchParams({
    bbox: bounds.join(","),
    includeUncertainAccess: "true",
    includeAccessPoints: "false",
  });
  return `/api/packs/${encodeURIComponent(packId)}/access-points?${query}`;
}

export function trailNetworkFeatureDetails(properties?: Record<string, unknown> | null): {
  name: string;
  distance?: string;
} {
  const name = properties?.name;
  const rawDistanceMeters = properties?.distanceMeters;
  const distanceMeters = typeof rawDistanceMeters === "number" && Number.isFinite(rawDistanceMeters)
    ? rawDistanceMeters
    : undefined;
  return {
    name: typeof name === "string" && name.trim() ? name.trim() : "Unnamed trail",
    distance: distanceMeters === undefined
      ? undefined
      : distanceMeters < 160.9344
        ? `${Math.round(distanceMeters * 3.28084)} ft`
        : `${(distanceMeters / 1609.344).toFixed(1)} mi`,
  };
}

/* Widths are authored at zoom 14 and scaled down so low zooms stay readable. */
function zoomWidth(wide: number): DataDrivenPropertyValueSpecification<number> {
  return ["interpolate", ["linear"], ["zoom"], 8, wide * 0.45, 12, wide * 0.8, 15, wide];
}

export function lineBounds(geometry: LineString): Bounds | null {
  const coordinates = geometry.coordinates;
  if (coordinates.length === 0) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (lon === undefined || lat === undefined) continue;
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

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

const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };

function areaFeature(geometry?: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> | FeatureCollection<Point> {
  return geometry ? { type: "Feature", properties: { role: "trailhead-filter" }, geometry } : EMPTY_POINTS;
}

export function accessPointFeatures(accessPoints: AccessPointOption[], selectedAccessPointId?: string): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: accessPoints.map((point) => ({
      type: "Feature",
      properties: {
        id: point.id,
        name: point.name,
        selected: point.id === selectedAccessPointId,
      },
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

export function routeSegmentFeatures(
  routes: GeneratedClosedRouteV3[],
  selectedRouteId?: string,
  segmentId?: string,
): FeatureCollection<LineString> {
  const selectedRoute = routes.find((route) => route.id === selectedRouteId);
  if (!selectedRoute) return EMPTY_LINES;
  return {
    type: "FeatureCollection",
    features: (selectedRoute?.trailSegments ?? []).flatMap((segment, index) =>
      segmentId && segment.id !== segmentId ? [] : [{
        type: "Feature" as const,
        properties: {
          id: segment.id,
          routeId: selectedRoute.id,
          segmentNumber: index + 1,
          name: segment.name ?? "Unnamed trail segment",
        },
        geometry: segment.geometry,
      }]),
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
    // The selected route keeps its own styling while hovered; otherwise
    // pointing at the selected card would recolour it mid-interaction.
    hovered: routeFeatures(routes.filter((route) => route.id === hoveredRouteId && route.id !== selectedRouteId), selectedRouteId),
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

export function routeTrailheadPinFeatures(
  routes: GeneratedClosedRouteV3[],
  selectedRouteId?: string,
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: routeTrailheadPins(routes, selectedRouteId).map((pin) => ({
      type: "Feature",
      properties: {
        id: pin.nextRouteId,
        name: pin.name,
        numberLabel: pin.numberLabel,
        selected: pin.selected,
        dense: pin.numberLabel.length > 4,
      },
      geometry: { type: "Point", coordinates: pin.coordinates },
    })),
  };
}

export function HikeMap({
  packId,
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
  selectedSegmentId,
  hoveredSegmentId,
  onBoundsChange,
  onAccessPointSelect,
  onRouteSelect,
  onRouteHover,
  onSegmentSelect,
  onSegmentHover,
}: HikeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerFactoryRef = useRef<typeof Marker | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const fittedRouteSetRef = useRef<string>(undefined);
  const onRouteHoverRef = useRef(onRouteHover);
  const onRouteSelectRef = useRef(onRouteSelect);
  const onSegmentSelectRef = useRef(onSegmentSelect);
  const onSegmentHoverRef = useRef(onSegmentHover);
  const onAccessPointSelectRef = useRef(onAccessPointSelect);
  const startRef = useRef<[number, number] | null>(null);
  const draftBoundsRef = useRef<Bounds | null>(null);
  const boundsRef = useRef(bounds);
  const accessPointsRef = useRef(accessPoints);
  const trailNetworkRef = useRef(trailNetwork);
  const selectedAccessPointIdRef = useRef(selectedAccessPointId);
  const routesRef = useRef(routes);
  const selectedRouteIdRef = useRef(selectedRouteId);
  const selectedSegmentIdRef = useRef(selectedSegmentId);
  const hoveredSegmentIdRef = useRef(hoveredSegmentId);
  const filterGeometryRef = useRef(filterGeometry);
  const refinementGeometryRef = useRef(refinementGeometry);
  const [drawing, setDrawing] = useState(false);
  const [hoveredRouteId, setHoveredRouteId] = useState<string>();
  const [hoveredTrail, setHoveredTrail] = useState<{ name: string; distance?: string }>();
  const [mapReady, setMapReady] = useState(false);

  // Map-originated hover drives the results list as well as the map itself.
  const previewRoute = useCallback((id?: string) => {
    setHoveredRouteId(id);
    onRouteHoverRef.current?.(id);
  }, []);

  // Callback props are read through refs so that a parent re-render can never
  // land in the map-construction effect's dependency list. It used to, which
  // tore down and rebuilt the whole map on every keystroke in the plan panel.
  useEffect(() => {
    onRouteHoverRef.current = onRouteHover;
    onRouteSelectRef.current = onRouteSelect;
    onAccessPointSelectRef.current = onAccessPointSelect;
    onSegmentSelectRef.current = onSegmentSelect;
    onSegmentHoverRef.current = onSegmentHover;
  }, [onAccessPointSelect, onRouteHover, onRouteSelect, onSegmentHover, onSegmentSelect]);

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
    selectedSegmentIdRef.current = selectedSegmentId;
    hoveredSegmentIdRef.current = hoveredSegmentId;
  }, [hoveredSegmentId, routes, selectedRouteId, selectedSegmentId]);

  useEffect(() => {
    filterGeometryRef.current = filterGeometry;
    refinementGeometryRef.current = refinementGeometry;
  }, [filterGeometry, refinementGeometry]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let alive = true;
    let map: MapLibreMap | null = null;
    let trailNetworkController: AbortController | null = null;
    void import("maplibre-gl").then(({ Map, Marker: MarkerClass, NavigationControl, setWorkerUrl }) => {
      if (!alive || !containerRef.current) return;
      setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
      markerFactoryRef.current = MarkerClass;
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
        // Coverage is a reference outline, not a highlight: no fill, and a
        // hairline edge that never competes with routes or the boundary box.
        map?.addLayer({
          id: "pack-coverage-casing",
          type: "line",
          source: "pack-coverage",
          paint: { "line-color": CASING, "line-width": 3, "line-opacity": 0.7 },
        });
        map?.addLayer({
          id: "pack-coverage-line",
          type: "line",
          source: "pack-coverage",
          paint: { "line-color": "#5c7f72", "line-width": 1.25, "line-opacity": 0.8, "line-dasharray": [4, 3] },
        });
        map?.addSource("trailhead-filter", { type: "geojson", data: filterGeometryRef.current ? areaFeature(filterGeometryRef.current) : initialBounds ? boundsPolygon(initialBounds) : EMPTY_POINTS });
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
        // The trail network is context, not content: keep it hairline so
        // generated routes are the only prominent lines on the map.
        map?.addLayer({
          id: "trail-network-casing",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          paint: { "line-color": CASING, "line-width": zoomWidth(5.5), "line-opacity": 0.88 },
        });
        map?.addLayer({
          id: "trail-network-lines",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          paint: { "line-color": "#3f5f52", "line-width": zoomWidth(2.4), "line-opacity": 0.92, "line-dasharray": [2.5, 3] },
        });
        map?.addLayer({
          id: "trail-network-hit-target",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          paint: { "line-color": "#000000", "line-width": 12, "line-opacity": 0.01 },
        });
        map?.addLayer({
          id: "trail-network-hover-casing",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          filter: EMPTY_TRAIL_HOVER_FILTER,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": CASING, "line-width": zoomWidth(9), "line-opacity": 0.94 },
        });
        map?.addLayer({
          id: "trail-network-hover",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          filter: EMPTY_TRAIL_HOVER_FILTER,
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": "#244c3d", "line-width": zoomWidth(5), "line-opacity": 0.96, "line-dasharray": [1.2, 1.8] },
        });
        // Access points cluster while zoomed out and split apart on zoom in.
        map?.addSource("access-points", {
          type: "geojson",
          data: accessPointFeatures(accessPointsRef.current, selectedAccessPointIdRef.current),
          cluster: true,
          clusterRadius: 42,
          clusterMaxZoom: 13,
        });
        map?.addLayer({
          id: "access-point-cluster-halo",
          type: "circle",
          source: "access-points",
          filter: ["has", "point_count"],
          paint: {
            "circle-radius": ["step", ["get", "point_count"], 13, 10, 17, 30, 21, 100, 26],
            "circle-color": "#2f6a55",
            "circle-opacity": 0.18,
          },
        });
        map?.addLayer({
          id: "access-point-clusters",
          type: "circle",
          source: "access-points",
          filter: ["has", "point_count"],
          paint: {
            // Cluster size reads as "how many trailheads are hiding here".
            "circle-radius": ["step", ["get", "point_count"], 7, 10, 9.5, 30, 12, 100, 15],
            "circle-color": "#1f4a3d",
            "circle-stroke-color": CASING,
            "circle-stroke-width": 2,
          },
        });
        map?.addLayer({
          id: "access-points",
          type: "circle",
          source: "access-points",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": zoomWidth(5.5),
            "circle-color": [
              "case",
              ["==", ["get", "selected"], true], ROUTE_SELECTED,
              "#173f35",
            ],
            "circle-stroke-color": CASING,
            "circle-stroke-width": 1.5,
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
        map?.addSource("generated-route-segments-hit", {
          type: "geojson",
          data: routeSegmentFeatures(routesRef.current, selectedRouteIdRef.current),
        });
        map?.addSource("generated-route-segment-focus", {
          type: "geojson",
          data: routeSegmentFeatures(
            routesRef.current,
            selectedRouteIdRef.current,
            hoveredSegmentIdRef.current ?? selectedSegmentIdRef.current ?? "__none__",
          ),
        });
        // Three states, one visual language: unselected routes are thin green,
        // the hovered route is the same green but heavier, and the selected
        // route is orange. Every state shares a white casing, so the only thing
        // that changes between them is weight and hue — never line pattern.
        map?.addLayer({
          id: "generated-route-alternate-casing",
          type: "line",
          source: "generated-route-alternates",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": CASING, "line-width": zoomWidth(5), "line-opacity": 0.85 },
        });
        map?.addLayer({
          id: "generated-route-alternates",
          type: "line",
          source: "generated-route-alternates",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_ALTERNATE, "line-width": zoomWidth(2.5), "line-opacity": 0.85 },
        });
        map?.addLayer({
          id: "generated-route-hover-casing",
          type: "line",
          source: "generated-route-hover",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": CASING, "line-width": zoomWidth(8) },
        });
        map?.addLayer({
          id: "generated-route-hover",
          type: "line",
          source: "generated-route-hover",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_ALTERNATE, "line-width": zoomWidth(4) },
        });
        map?.addLayer({
          id: "generated-route-selected-casing",
          type: "line",
          source: "generated-route-selected",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": CASING, "line-width": zoomWidth(9) },
        });
        map?.addLayer({
          id: "generated-route-selected",
          type: "line",
          source: "generated-route-selected",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_SELECTED, "line-width": zoomWidth(5) },
        });
        map?.addLayer({
          id: "generated-route-segment-focus-casing",
          type: "line",
          source: "generated-route-segment-focus",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": CASING, "line-width": zoomWidth(13), "line-opacity": 0.95 },
        });
        map?.addLayer({
          id: "generated-route-segment-focus",
          type: "line",
          source: "generated-route-segment-focus",
          layout: { "line-join": "round", "line-cap": "round" },
          // Zero transition: hovering a segment is a pointer response, and
          // MapLibre's default 300 ms colour cross-fade reads as lag.
          paint: { "line-color": ROUTE_SELECTED, "line-color-transition": { duration: 0, delay: 0 }, "line-width": zoomWidth(8) },
        });
        map?.addLayer({
          id: "generated-route-hit-target",
          type: "line",
          source: "generated-routes-hit",
          paint: { "line-color": "#000000", "line-width": 14, "line-opacity": 0.01 },
        });
        map?.addLayer({
          id: "generated-route-segment-hit-target",
          type: "line",
          source: "generated-route-segments-hit",
          paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0.01 },
        });
        const selectRoute = (event: MapLayerMouseEvent) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onRouteSelectRef.current(id);
        };
        map?.on("click", "generated-route-hit-target", selectRoute);
        map?.on("mousemove", "generated-route-hit-target", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          map?.getCanvas().style.setProperty("cursor", "pointer");
          previewRoute(id);
        });
        map?.on("mouseleave", "generated-route-hit-target", () => {
          map?.getCanvas().style.removeProperty("cursor");
          previewRoute(undefined);
        });
        map?.on("click", "generated-route-segment-hit-target", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onSegmentSelectRef.current?.(id);
        });
        map?.on("mousemove", "generated-route-segment-hit-target", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          map?.getCanvas().style.setProperty("cursor", "pointer");
          onSegmentHoverRef.current?.(id);
        });
        map?.on("mouseleave", "generated-route-segment-hit-target", () => {
          map?.getCanvas().style.removeProperty("cursor");
          onSegmentHoverRef.current?.(undefined);
        });
        map?.on("mousemove", "trail-network-hit-target", (event) => {
          const feature = event.features?.[0];
          if (!feature) return;
          const id = feature.properties?.trailGroupId;
          if (typeof id !== "string") return;
          map?.getCanvas().style.setProperty("cursor", "pointer");
          map?.setFilter("trail-network-hover-casing", trailNetworkHoverFilter(id));
          map?.setFilter("trail-network-hover", trailNetworkHoverFilter(id));
          setHoveredTrail(trailNetworkFeatureDetails(feature.properties));
        });
        map?.on("mouseleave", "trail-network-hit-target", () => {
          map?.getCanvas().style.removeProperty("cursor");
          map?.setFilter("trail-network-hover-casing", EMPTY_TRAIL_HOVER_FILTER);
          map?.setFilter("trail-network-hover", EMPTY_TRAIL_HOVER_FILTER);
          setHoveredTrail(undefined);
        });
        // Clicking a cluster zooms to the level where it breaks apart.
        map?.on("click", "access-point-clusters", (event) => {
          const clusterId = event.features?.[0]?.properties?.cluster_id;
          const source = map?.getSource("access-points") as GeoJSONSource | undefined;
          if (typeof clusterId !== "number" || !source) return;
          void source.getClusterExpansionZoom(clusterId).then((zoom) => {
            map?.easeTo({ center: event.lngLat, zoom, duration: 350 });
          }).catch(() => undefined);
        });
        map?.on("mouseenter", "access-point-clusters", () => map?.getCanvas().style.setProperty("cursor", "pointer"));
        map?.on("mouseleave", "access-point-clusters", () => map?.getCanvas().style.removeProperty("cursor"));
        map?.on("click", "access-points", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onAccessPointSelectRef.current(id);
        });

        const refreshTrailNetwork = () => {
          if (!map) return;
          const visibleBounds = map.getBounds();
          const requestUrl = trailNetworkRequestUrl(packId, [
            visibleBounds.getWest(),
            visibleBounds.getSouth(),
            visibleBounds.getEast(),
            visibleBounds.getNorth(),
          ], map.getZoom());
          trailNetworkController?.abort();
          trailNetworkController = null;
          map.setFilter("trail-network-hover-casing", EMPTY_TRAIL_HOVER_FILTER);
          map.setFilter("trail-network-hover", EMPTY_TRAIL_HOVER_FILTER);
          setHoveredTrail(undefined);
          const source = map.getSource("trail-network") as GeoJSONSource | undefined;
          if (!requestUrl) {
            source?.setData(EMPTY_LINES);
            return;
          }
          const controller = new AbortController();
          trailNetworkController = controller;
          void fetch(requestUrl, { signal: controller.signal })
            .then(async (response) => {
              const payload: unknown = await response.json().catch(() => null);
              if (!response.ok || !payload || typeof payload !== "object" || !("trailNetwork" in payload)) return;
              const trailNetwork = payload.trailNetwork;
              if (controller.signal.aborted || !trailNetwork || typeof trailNetwork !== "object" || !("type" in trailNetwork) || trailNetwork.type !== "FeatureCollection") return;
              source?.setData(trailNetwork as FeatureCollection<LineString>);
            })
            .catch(() => undefined);
        };
        map?.on("moveend", refreshTrailNetwork);
        refreshTrailNetwork();
        setMapReady(true);
      });
    });
    return () => {
      alive = false;
      trailNetworkController?.abort();
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [display.center, display.zoom, packCoverage, packCoverageBbox, packId, previewRoute]);

  useEffect(() => {
    const source = mapRef.current?.getSource("trailhead-filter") as GeoJSONSource | undefined;
    source?.setData(areaFeature(filterGeometry));
    const refinementSource = mapRef.current?.getSource("region-refinement") as GeoJSONSource | undefined;
    refinementSource?.setData(areaFeature(refinementGeometry));
  }, [filterGeometry, refinementGeometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer("pack-coverage-line")) return;
    map.setPaintProperty("pack-coverage-line", "line-opacity", showCoverageHatching(filterGeometry ? bounds : null, drawing) ? 0.8 : 0.35);
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
    (map.getSource("generated-route-segments-hit") as GeoJSONSource | undefined)?.setData(
      routeSegmentFeatures(routes, selectedRouteId),
    );
    (map.getSource("generated-route-segment-focus") as GeoJSONSource | undefined)?.setData(
      routeSegmentFeatures(routes, selectedRouteId, hoveredSegmentId ?? selectedSegmentId ?? "__none__"),
    );
    // The selected route is already orange, so an orange focus would only read
    // as slightly fatter. Hover borrows the green the map gives every hovered
    // route, which is also the colour the panel row picks up.
    if (map.getLayer("generated-route-segment-focus")) {
      map.setPaintProperty("generated-route-segment-focus", "line-color", hoveredSegmentId ? ROUTE_ALTERNATE : ROUTE_SELECTED);
    }
  }, [hoveredRouteId, hoveredSegmentId, mapReady, routes, selectedRouteId, selectedSegmentId]);

  // Numbered start pins are DOM markers rather than a symbol layer: the style
  // ships no glyph endpoint, so map-rendered text would never appear at all.
  useEffect(() => {
    const map = mapRef.current;
    const MarkerFactory = markerFactoryRef.current;
    if (!map || !mapReady || !MarkerFactory) return;
    const markers = routeTrailheadPins(routes, selectedRouteId).map((pin) => {
      // MapLibre writes its positioning transform onto the element it is given,
      // so the anchor must be a bare wrapper. Any transform or transition on
      // that element fights the map and makes the pin drift while zooming.
      const anchor = document.createElement("div");
      anchor.className = "route-pin-anchor";
      const element = document.createElement("button");
      element.type = "button";
      element.className = ["route-pin", pin.selected ? "selected" : "", pin.numberLabel.length > 3 ? "wide" : ""].filter(Boolean).join(" ");
      element.textContent = pin.numberLabel;
      element.title = pin.name;
      element.setAttribute("aria-label", `Route ${pin.numberLabel} start at ${pin.name}`);
      element.addEventListener("click", (event) => { event.stopPropagation(); onRouteSelectRef.current(pin.nextRouteId); });
      element.addEventListener("mouseenter", () => previewRoute(pin.selected ? selectedRouteId : pin.routeIds[0]));
      element.addEventListener("mouseleave", () => previewRoute(undefined));
      anchor.append(element);
      return new MarkerFactory({ element: anchor, anchor: "center", subpixelPositioning: true }).setLngLat(pin.coordinates).addTo(map);
    });
    markersRef.current = markers;
    return () => { markers.forEach((marker) => marker.remove()); };
  }, [mapReady, previewRoute, routes, selectedRouteId]);

  // Framing rules, in priority order:
  //   1. A brand new result set frames every route, so results are never left
  //      as an unreadable speck inside the whole drive-time area.
  //   2. Afterwards, selecting a route only moves the map when that route is
  //      off screen — otherwise walking the results list jitters the view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (routes.length === 0) { fittedRouteSetRef.current = undefined; return; }

    const signature = `${routes.length}:${routes[0]?.id ?? ""}:${routes.at(-1)?.id ?? ""}`;
    if (fittedRouteSetRef.current !== signature) {
      fittedRouteSetRef.current = signature;
      const union = routes.reduce<Bounds | null>((accumulated, route) => {
        const next = lineBounds(route.geometry);
        if (!next) return accumulated;
        if (!accumulated) return next;
        return [
          Math.min(accumulated[0], next[0]), Math.min(accumulated[1], next[1]),
          Math.max(accumulated[2], next[2]), Math.max(accumulated[3], next[3]),
        ];
      }, null);
      if (union) map.fitBounds([[union[0], union[1]], [union[2], union[3]]], { padding: 64, maxZoom: 14, duration: 550 });
      return;
    }

    if (!selectedRouteId) return;
    const route = routes.find(({ id }) => id === selectedRouteId);
    const target = route ? lineBounds(route.geometry) : null;
    if (!target) return;
    const view = map.getBounds();
    if (view.contains([target[0], target[1]]) && view.contains([target[2], target[3]])) return;
    map.fitBounds([[target[0], target[1]], [target[2], target[3]]], { padding: 72, maxZoom: 15, duration: 450 });
  }, [mapReady, routes, selectedRouteId]);

  // Hover announced by the results list (card pointer or focus).
  useEffect(() => {
    const handleRoutePreview = (event: Event) => {
      setHoveredRouteId((event as CustomEvent<{ routeId?: string }>).detail?.routeId);
    };
    window.addEventListener(ROUTE_PREVIEW_EVENT, handleRoutePreview);
    return () => window.removeEventListener(ROUTE_PREVIEW_EVENT, handleRoutePreview);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !drawing || !drawEnabled) return;
    const previewSource = map.getSource("boundary-preview") as GeoJSONSource | undefined;
    const cornerSource = map.getSource("boundary-preview-corners") as GeoJSONSource | undefined;
    const clearPreview = () => {
      previewSource?.setData(EMPTY_POINTS);
      cornerSource?.setData(EMPTY_POINTS);
      draftBoundsRef.current = null;
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
      <details className="map-key map-key-collapsible">
        <summary className="map-key-toggle">Map key</summary>
        <div className="map-key-content" aria-label="Map symbol explanations">
          <span><i className="key-coverage" aria-hidden="true" />Installed coverage</span>
          {filterGeometry ? <span><i className="key-filter" aria-hidden="true" />Trailhead filter</span> : null}
          {refinementGeometry ? <span><i className="key-refinement" aria-hidden="true" />Named refinement</span> : null}
          <span><i className="key-access" aria-hidden="true" />Trailhead</span>
          <span><i className="key-trail" aria-hidden="true" />Mapped trail</span>
          {routes.length > 0 ? <span><i className="key-route" aria-hidden="true" />Suggested route</span> : null}
          {routes.length > 0 ? <span><i className="key-start" aria-hidden="true" />Route start</span> : null}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" aria-label="OpenStreetMap attribution">© OpenStreetMap contributors</a>
        </div>
      </details>
      {drawing || hoveredTrail ? <p className={`map-hint${hoveredTrail && !drawing ? " map-trail-label" : ""}`} role="status" aria-live="polite">
        {drawing ? "Draw a trailhead filter. It may extend beyond installed coverage." : <>
          {hoveredTrail?.distance ? <span className="map-trail-distance">{hoveredTrail.distance}</span> : null}
          <span>{hoveredTrail?.name}</span>
        </>}
      </p> : null}
    </section>
  );
}
