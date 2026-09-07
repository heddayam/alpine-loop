"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from "geojson";
import type { DataDrivenPropertyValueSpecification, ExpressionSpecification, FilterSpecification, Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import { lineStringSchema, type GeneratedClosedRouteV3 } from "@/lib/contracts";
import { z } from "zod";
import type { AccessPointOption, Bounds } from "../builder/types";
import { boundsCorners, boundsPolygon, normalizeBounds } from "./geometry";
import { routeStart } from "../results/route-start";
import { COPY_FEEDBACK_MS, copyTextToClipboard, copyTextWithDocument } from "../clipboard";

type HikeMapProps = {
  drawBounds: Bounds | null;
  filterGeometry?: Polygon | MultiPolygon;
  refinementGeometry?: Polygon | MultiPolygon;
  coverages: Array<Polygon | MultiPolygon>;
  showRegionBoundaries: boolean;
  display: { center: [number, number]; zoom: number };
  includeUncertainAccess: boolean;
  routes: GeneratedClosedRouteV3[];
  selectedRouteId?: string;
  selectedStartKey?: string;
  hoveredRouteId?: string;
  selectedSegmentId?: string;
  hoveredSegmentId?: string;
  onBoundsChange: (bounds: Bounds | null) => void;
  onStartSelect: (key: string) => void;
  onRouteSelect: (id: string) => void;
  onRouteHover?: (id?: string) => void;
  onSegmentSelect?: (id: string) => void;
  onSegmentHover?: (id?: string) => void;
};

/* One hue per meaning: orange is the selection and nothing else; green is
   every unselected route. Weight distinguishes hover and segment focus. */
const ROUTE_SELECTED = "#d83b20";
const ROUTE_ALTERNATE = "#2f6a55";
const ROUTE_WIDTH = 2;
const ROUTE_CASING = "#fffdf7";
const SEGMENT_FOCUS = "#a62e19";
const ROUTE_EMPHASIS_WIDTH = 4;
const TRAIL_NETWORK_COLOR = "#3f5f52";
const TRAIL_NETWORK_HOVER_COLOR = "#244c3d";
const TRAIL_NETWORK_WIDTH = 2.4;
const TRAIL_NETWORK_HOVER_WIDTH = 2.7;
export const TRAIL_NETWORK_MIN_ZOOM = 12;
/* The menu is positioned from the click point, so it needs its own size to
   stay inside the map instead of being clipped at the right or bottom edge.
   The width covers the single line at its widest: coordinates plus the copy
   label, which the stylesheet never wraps. */
const CONTEXT_MENU_SIZE = { width: 200, height: 34 };
const EMPTY_ACCESS_POINT_HOVER_FILTER: FilterSpecification = ["==", ["get", "id"], "__none__"];
const EMPTY_ACCESS_POINT_CLUSTER_HOVER_FILTER: FilterSpecification = ["==", ["get", "cluster_id"], -1];

type HoveredTrail = {
  id: string;
  name: string;
  distance?: string;
};

type MapCopyFeedback = {
  kind: "trail" | "access-point";
  id: string;
  status: "copied" | "failed";
};

type MapContextMenu = {
  left: number;
  top: number;
  coordinates: string;
};

type HoveredAccessPoint = {
  id: string | number;
  kindLabel: string;
  name: string;
};

const TRAIL_CLICK_PRIORITY_LAYERS = [
  "generated-starts",
  "generated-route-segment-hit-target",
  "generated-route-hit-target",
  "access-points",
  "access-point-clusters",
];

export function accessPointHoverFilter(id?: string): FilterSpecification {
  return id ? ["==", ["get", "id"], id] : EMPTY_ACCESS_POINT_HOVER_FILTER;
}

export function accessPointClusterHoverFilter(id?: number): FilterSpecification {
  return id === undefined ? EMPTY_ACCESS_POINT_CLUSTER_HOVER_FILTER : ["==", ["get", "cluster_id"], id];
}

export function accessPointFeatureDetails(properties?: Record<string, unknown> | null): {
  id?: string;
  kindLabel: string;
  name: string;
  copyName?: string;
} {
  const id = properties?.id;
  const name = properties?.name;
  const kind = properties?.kind;
  const copyName = typeof name === "string" && name.trim() ? name.trim() : undefined;
  return {
    id: typeof id === "string" ? id : undefined,
    kindLabel: kind === "parking" ? "Parking" : kind === "transit" ? "Transit" : "Trailhead",
    name: copyName ?? "Unnamed access point",
    copyName,
  };
}

/* Latitude first, five decimals: the order and precision people paste into
   another map. Longitude is wrapped so panning past the antimeridian cannot
   report a coordinate no other tool accepts. */
export function formatCoordinates(lng: number, lat: number): string {
  const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;
  return `${lat.toFixed(5)}, ${wrappedLng.toFixed(5)}`;
}

export function contextMenuPosition(
  point: { x: number; y: number },
  container: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(point.x, container.width - CONTEXT_MENU_SIZE.width)),
    top: Math.max(0, Math.min(point.y, container.height - CONTEXT_MENU_SIZE.height)),
  };
}

export function mapRequestUrl(bounds: Bounds, zoom: number): string {
  return `/api/map?${new URLSearchParams({ bbox: bounds.join(","), trails: zoom >= TRAIL_NETWORK_MIN_ZOOM ? "1" : "0" })}`;
}

export const mapDataSchema = z.object({
  accessPoints: z.array(z.object({
    id: z.string(), name: z.string(), lon: z.number().finite(), lat: z.number().finite(),
    kind: z.enum(["trailhead", "parking", "transit"]), accessState: z.enum(["public", "unknown"]), confidence: z.enum(["high", "medium", "low"]),
  })),
  trailNetwork: z.object({ type: z.literal("FeatureCollection"), features: z.array(z.object({
    type: z.literal("Feature"), geometry: lineStringSchema, properties: z.record(z.string(), z.unknown()),
  })) }),
});

export function trailNetworkFeatureDetails(properties?: Record<string, unknown> | null): {
  name: string;
  copyName?: string;
  distance?: string;
} {
  const name = properties?.name;
  const copyName = typeof name === "string" && name.trim() ? name.trim() : undefined;
  const rawDistanceMeters = properties?.distanceMeters;
  const distanceMeters = typeof rawDistanceMeters === "number" && Number.isFinite(rawDistanceMeters)
    ? rawDistanceMeters
    : undefined;
  return {
    name: copyName ?? "Unnamed trail",
    copyName,
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

export function trailNetworkLineColor(hoveredId?: string): DataDrivenPropertyValueSpecification<string> {
  return hoveredId
    ? ["case", ["==", ["get", "trailGroupId"], hoveredId], TRAIL_NETWORK_HOVER_COLOR, TRAIL_NETWORK_COLOR]
    : TRAIL_NETWORK_COLOR;
}

/* Keep the hover lift small. The dash array itself never changes: changing it
   causes MapLibre's dash texture to visibly crawl along the trail. */
export function trailNetworkLineWidth(hoveredId?: string): DataDrivenPropertyValueSpecification<number> {
  return hoveredId
    ? ["case", ["==", ["get", "trailGroupId"], hoveredId], TRAIL_NETWORK_HOVER_WIDTH, TRAIL_NETWORK_WIDTH]
    : TRAIL_NETWORK_WIDTH;
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

const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };

function areaFeature(geometry?: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> | FeatureCollection<Point> {
  return geometry ? { type: "Feature", properties: { role: "trailhead-filter" }, geometry } : EMPTY_POINTS;
}

export function coverageFeatures(
  coverages: Array<Polygon | MultiPolygon>,
): FeatureCollection<Polygon | MultiPolygon> {
  return {
    type: "FeatureCollection",
    features: coverages.map((geometry) => ({
      type: "Feature",
      properties: { role: "pack-coverage" },
      geometry,
    })),
  };
}

export function regionBoundaryVisibility(showRegionBoundaries: boolean): "visible" | "none" {
  return showRegionBoundaries ? "visible" : "none";
}

export const REGION_BOUNDARY_PAINT = {
  "line-color": "#111111",
  "line-width": 0.8,
  "line-opacity": 0.58,
} as const;

export function resultAccessPointIds(routes: GeneratedClosedRouteV3[]): Set<string> {
  return new Set(routes.map((route) => route.startAccessPoint.id));
}

export function accessPointFeatures(
  accessPoints: AccessPointOption[],
  hiddenAccessPointIds: ReadonlySet<string> = new Set(),
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: accessPoints.filter((point) => !hiddenAccessPointIds.has(point.id)).map((point) => ({
      type: "Feature",
      properties: {
        id: point.id,
        name: point.name,
        kind: point.kind,
      },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
    })),
  };
}

export function routeFeatures(routes: GeneratedClosedRouteV3[]): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: routes.map((route) => ({
      type: "Feature",
      properties: {
        id: route.id,
        startKey: routeStart(route).key,
        shape: route.topology.kind,
      },
      geometry: route.geometry,
    })),
  };
}

export function routeSegmentFeatures(route?: GeneratedClosedRouteV3): FeatureCollection<LineString> {
  if (!route) return EMPTY_LINES;
  return {
    type: "FeatureCollection",
    features: (route.trailSegments ?? []).map((segment, index) => ({
      type: "Feature",
      properties: {
        id: segment.id,
        routeId: route.id,
        segmentNumber: index + 1,
        name: segment.name ?? "Unnamed trail segment",
      },
      geometry: segment.geometry,
    })),
  };
}

function routeFilter(id?: string): ExpressionSpecification {
  return ["in", ["get", "id"], ["literal", id === undefined ? [] : [id]]];
}

/** One feature per real start; nearby starts never acquire an invented midpoint. */
export function routeStartFeatures(routes: GeneratedClosedRouteV3[]): FeatureCollection<Point> {
  const starts = new Map<string, Feature<Point, { key: string; name: string; count: number }>>();
  for (const route of routes) {
    const { key, name, coordinates } = routeStart(route);
    const existing = starts.get(key);
    if (existing) existing.properties.count += 1;
    else starts.set(key, {
      type: "Feature", properties: { key, name, count: 1 },
      geometry: { type: "Point", coordinates },
    });
  }
  return { type: "FeatureCollection", features: [...starts.values()] };
}

export function HikeMap({
  drawBounds: bounds,
  filterGeometry,
  refinementGeometry,
  coverages,
  showRegionBoundaries,
  display,
  includeUncertainAccess,
  routes,
  selectedRouteId,
  selectedStartKey,
  hoveredRouteId,
  selectedSegmentId,
  hoveredSegmentId,
  onBoundsChange,
  onStartSelect,
  onRouteSelect,
  onRouteHover,
  onSegmentSelect,
  onSegmentHover,
}: HikeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const fittedRouteSetRef = useRef<string>(undefined);
  const onRouteHoverRef = useRef(onRouteHover);
  const onStartSelectRef = useRef(onStartSelect);
  const onRouteSelectRef = useRef(onRouteSelect);
  const clearMapHoverRef = useRef<(() => void) | undefined>(undefined);
  const interactionRef = useRef({ selectedStartKey, selectedRouteId });
  const onSegmentSelectRef = useRef(onSegmentSelect);
  const onSegmentHoverRef = useRef(onSegmentHover);
  const startRef = useRef<[number, number] | null>(null);
  const draftBoundsRef = useRef<Bounds | null>(null);
  const boundsRef = useRef(bounds);
  const coveragesRef = useRef(coverages);
  const showRegionBoundariesRef = useRef(showRegionBoundaries);
  const filterGeometryRef = useRef(filterGeometry);
  const refinementGeometryRef = useRef(refinementGeometry);
  const mapCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coordinateCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  const drawingClickRef = useRef(false);
  const selectedRoute = routes.find(({ id }) => id === selectedRouteId);
  const changeDrawing = useCallback((active: boolean) => {
    drawingRef.current = active;
    setDrawing(active);
  }, []);
  const [hoveredTrail, setHoveredTrail] = useState<HoveredTrail>();
  const [hoveredAccessPoint, setHoveredAccessPoint] = useState<HoveredAccessPoint>();
  const [mapCopyFeedback, setMapCopyFeedback] = useState<MapCopyFeedback>();
  const [contextMenu, setContextMenu] = useState<MapContextMenu>();
  const [coordinateCopyStatus, setCoordinateCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [mapReady, setMapReady] = useState(false);
  const [mapData, setMapData] = useState<z.infer<typeof mapDataSchema>>({ accessPoints: [], trailNetwork: { type: "FeatureCollection", features: [] } });
  const [mapError, setMapError] = useState("");

  useEffect(() => () => {
    if (mapCopyTimerRef.current) clearTimeout(mapCopyTimerRef.current);
    if (coordinateCopyTimerRef.current) clearTimeout(coordinateCopyTimerRef.current);
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(undefined);
    setCoordinateCopyStatus("idle");
    if (coordinateCopyTimerRef.current) {
      clearTimeout(coordinateCopyTimerRef.current);
      coordinateCopyTimerRef.current = null;
    }
  }, []);

  // Map-originated hover drives the results list as well as the map itself.
  const previewRoute = useCallback((id?: string) => {
    onRouteHoverRef.current?.(id);
  }, []);

  // Callback props are read through refs so that a parent re-render can never
  // land in the map-construction effect's dependency list. It used to, which
  // tore down and rebuilt the whole map on every keystroke in the plan panel.
  useEffect(() => {
    onRouteHoverRef.current = onRouteHover;
    onStartSelectRef.current = onStartSelect;
    onRouteSelectRef.current = onRouteSelect;
    interactionRef.current = { selectedStartKey, selectedRouteId };
    onSegmentSelectRef.current = onSegmentSelect;
    onSegmentHoverRef.current = onSegmentHover;
  }, [onRouteHover, onRouteSelect, onStartSelect, onSegmentHover, onSegmentSelect, selectedStartKey, selectedRouteId]);

  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    coveragesRef.current = coverages;
    const source = mapRef.current?.getSource("pack-coverage") as GeoJSONSource | undefined;
    source?.setData(coverageFeatures(coverages));
  }, [coverages]);

  useEffect(() => {
    showRegionBoundariesRef.current = showRegionBoundaries;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const visibility = regionBoundaryVisibility(showRegionBoundaries);
    if (map.getLayer("pack-coverage-line")) map.setLayoutProperty("pack-coverage-line", "visibility", visibility);
    if (map.getLayer("region-refinement-line")) map.setLayoutProperty("region-refinement-line", "visibility", visibility);
  }, [mapReady, showRegionBoundaries]);

  useEffect(() => {
    filterGeometryRef.current = filterGeometry;
    refinementGeometryRef.current = refinementGeometry;
  }, [filterGeometry, refinementGeometry]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let alive = true;
    let map: MapLibreMap | null = null;
    let trailNetworkController: AbortController | null = null;
    let resizeObserver: ResizeObserver | undefined;
    void import("maplibre-gl").then(({ Map, NavigationControl, setWorkerUrl }) => {
      if (!alive || !containerRef.current) return;
      setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
      map = new Map({
        container: containerRef.current,
        center: display.center,
        zoom: display.zoom,
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
      resizeObserver = new ResizeObserver(() => { if (alive) map?.resize(); });
      resizeObserver.observe(containerRef.current);
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        if (!alive) return;
        const initialBounds = boundsRef.current;
        map?.addSource("pack-coverage", { type: "geojson", data: coverageFeatures(coveragesRef.current) });
        // Installed-pack coverage is optional reference geometry: one thin,
        // solid black hairline with no fill or casing.
        map?.addLayer({
          id: "pack-coverage-line",
          type: "line",
          source: "pack-coverage",
          layout: { visibility: regionBoundaryVisibility(showRegionBoundariesRef.current) },
          paint: REGION_BOUNDARY_PAINT,
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
        // Reviewed-region geometry uses the same optional, unobtrusive boundary
        // treatment as installed-pack coverage: no fill, casing, or dash.
        map?.addLayer({
          id: "region-refinement-line",
          type: "line",
          source: "region-refinement",
          layout: { visibility: regionBoundaryVisibility(showRegionBoundariesRef.current) },
          paint: REGION_BOUNDARY_PAINT,
        });
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
        map?.addSource("trail-network", { type: "geojson", data: EMPTY_LINES });
        // The trail network is context, not content: use a single quiet dashed
        // stroke without a casing so the basemap remains visible in the gaps.
        map?.addLayer({
          id: "trail-network-lines",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": trailNetworkLineColor(),
            "line-width": trailNetworkLineWidth(),
            "line-opacity": 0.92,
            "line-dasharray": [2.5, 2.5],
          },
        });
        map?.addLayer({
          id: "trail-network-hit-target",
          type: "line",
          source: "trail-network",
          minzoom: TRAIL_NETWORK_MIN_ZOOM,
          paint: { "line-color": "#000000", "line-width": 12, "line-opacity": 0 },
        });
        // Access points cluster while zoomed out and split apart on zoom in.
        map?.addSource("access-points", {
          type: "geojson",
          data: accessPointFeatures([]),
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
          },
        });
        map?.addLayer({
          id: "access-point-cluster-hover",
          type: "circle",
          source: "access-points",
          filter: EMPTY_ACCESS_POINT_CLUSTER_HOVER_FILTER,
          paint: {
            "circle-radius": ["step", ["get", "point_count"], 10, 10, 12.5, 30, 15, 100, 18],
            "circle-color": "#173f35",
          },
        });
        map?.addLayer({
          id: "access-points",
          type: "circle",
          source: "access-points",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": zoomWidth(5.5),
            "circle-color": "#173f35",
          },
        });
        map?.addLayer({
          id: "access-point-hover",
          type: "circle",
          source: "access-points",
          filter: EMPTY_ACCESS_POINT_HOVER_FILTER,
          paint: {
            "circle-radius": zoomWidth(7.5),
            "circle-color": "#173f35",
          },
        });
        // One geometry source serves every route state. Hover and selection
        // only change layer filters, avoiding repeated GeoJSON worker uploads.
        map?.addSource("generated-routes", { type: "geojson", data: EMPTY_LINES });
        map?.addSource("generated-route-segments", { type: "geojson", data: EMPTY_LINES });
        // Draw the preview above the chosen route so shared sections remain
        // traceable. Casings are crisp linework, never glows or animated strokes.
        for (const [id, source, color, width, opacity] of [
          ["generated-route-alternates", "generated-routes", ROUTE_ALTERNATE, zoomWidth(ROUTE_WIDTH), 0.8],
          ["generated-route-selected-casing", "generated-routes", ROUTE_CASING, zoomWidth(5), 1],
          ["generated-route-selected", "generated-routes", ROUTE_SELECTED, zoomWidth(3), 1],
          ["generated-route-segment-focus", "generated-route-segments", SEGMENT_FOCUS, zoomWidth(5), 1],
          ["generated-route-hover-casing", "generated-routes", ROUTE_CASING, zoomWidth(6), 1],
          ["generated-route-hover", "generated-routes", ROUTE_ALTERNATE, zoomWidth(ROUTE_EMPHASIS_WIDTH), 1],
          // Invisible geometry retains a generous pointer target.
          ["generated-route-hit-target", "generated-routes", "#000000", 14, 0],
          ["generated-route-segment-hit-target", "generated-route-segments", "#000000", 18, 0],
        ] as const) {
          map?.addLayer({
            id, type: "line", source,
            ...(id.includes("casing") || id.endsWith("selected") || id.endsWith("hover") || id.endsWith("focus") ? { filter: routeFilter() } : {}),
            layout: opacity ? { "line-join": "round", "line-cap": "round" } : {},
            paint: { "line-color": color, "line-width": width, "line-opacity": opacity,
              "line-opacity-transition": { duration: 0 }, "line-width-transition": { duration: 0 } },
          });
        }
        // Circles always render; only the count labels participate in native
        // collision handling. Omitting glyphs uses MapLibre's local font renderer.
        map?.addSource("generated-starts", { type: "geojson", data: EMPTY_POINTS });
        map?.addLayer({
          id: "generated-starts", type: "circle", source: "generated-starts",
          paint: { "circle-radius": 10, "circle-color": ROUTE_ALTERNATE, "circle-stroke-color": ROUTE_CASING, "circle-stroke-width": 0,
            "circle-color-transition": { duration: 0 }, "circle-stroke-width-transition": { duration: 0 } },
        });
        map?.addLayer({
          id: "generated-start-counts", type: "symbol", source: "generated-starts",
          layout: { "text-field": ["to-string", ["get", "count"]], "text-font": ["sans-serif"], "text-size": 11 },
          paint: { "text-color": "#ffffff" },
        });
        let moving = false;
        let hoverOwner: "start" | "route" | "segment" | "trail" | "accessPoint" | undefined;
        const cursorTargets = { start: false, route: false, segment: false, trail: false, accessPoint: false };
        const syncInteractiveCursor = () => {
          const canvas = map?.getCanvas();
          if (!canvas) return;
          if (drawingRef.current) { canvas.style.cursor = "crosshair"; return; }
          if (Object.values(cursorTargets).some(Boolean)) canvas.style.setProperty("cursor", "pointer");
          else canvas.style.removeProperty("cursor");
        };
        const startAtPoint = (point: MapLayerMouseEvent["point"]) => Boolean(
          map?.queryRenderedFeatures(point, { layers: ["generated-starts"] }).length,
        );
        const routeSegmentAtPoint = (point: MapLayerMouseEvent["point"]) => Boolean(
          interactionRef.current.selectedRouteId && map?.queryRenderedFeatures(point, { layers: ["generated-route-segment-hit-target"] }).length,
        );
        // Drawing owns all feature gestures, including the click emitted after
        // mouseup. The next pointer press releases that completed gesture.
        const onFeature = (type: "click" | "mousemove" | "mouseenter" | "mouseleave", layer: string, handle: (event: MapLayerMouseEvent) => void) => {
          map?.on(type, layer, (event) => {
            if (drawingRef.current || (type === "click" && drawingClickRef.current) || (moving && (type === "mousemove" || type === "mouseenter"))) return;
            handle(event);
          });
        };
        map?.on("mousedown", () => { if (!drawingRef.current) drawingClickRef.current = false; });
        const routeAtEvent = (event: MapLayerMouseEvent, scoped: boolean) => event.features?.find((feature) =>
          typeof feature.properties?.id === "string" && (!scoped || !interactionRef.current.selectedStartKey
            || feature.properties.startKey === interactionRef.current.selectedStartKey));
        onFeature("click", "generated-route-hit-target", (event) => {
          if (startAtPoint(event.point) || routeSegmentAtPoint(event.point)) return;
          const id = (routeAtEvent(event, true) ?? routeAtEvent(event, false))?.properties?.id;
          if (typeof id === "string") onRouteSelectRef.current(id);
        });
        onFeature("click", "generated-starts", (event) => {
          const key = event.features?.[0]?.properties?.key;
          if (typeof key === "string") onStartSelectRef.current(key);
        });
        const claimHover = (owner: typeof hoverOwner) => {
          hoverOwner = owner;
          if (owner !== "route") previewRoute(undefined);
          if (owner !== "segment") onSegmentHoverRef.current?.(undefined);
          if (owner !== "trail") clearTrailHover();
          clearAccessPointHover();
          for (const key of Object.keys(cursorTargets) as Array<keyof typeof cursorTargets>) cursorTargets[key] = key === owner;
          syncInteractiveCursor();
        };
        clearMapHoverRef.current = () => claimHover(undefined);
        onFeature("mousemove", "generated-starts", (event) => {
          const properties = event.features?.[0]?.properties;
          if (typeof properties?.key !== "string") return;
          claimHover("start");
          setHoveredAccessPoint({ id: properties.key, name: properties.name || "Unnamed trailhead", kindLabel: `${properties.count} ${properties.count === 1 ? "route" : "routes"}` });
        });
        onFeature("mouseleave", "generated-starts", () => {
          if (hoverOwner === "start") claimHover(undefined);
        });
        onFeature("mousemove", "generated-route-hit-target", (event) => {
          if (startAtPoint(event.point) || routeSegmentAtPoint(event.point)) return;
          const id = routeAtEvent(event, true)?.properties?.id;
          if (typeof id !== "string") { if (hoverOwner === "route") claimHover(undefined); return; }
          claimHover("route");
          previewRoute(id);
        });
        onFeature("mouseleave", "generated-route-hit-target", () => {
          if (hoverOwner === "route") claimHover(undefined);
        });
        onFeature("click", "generated-route-segment-hit-target", (event) => {
          if (!interactionRef.current.selectedRouteId || startAtPoint(event.point)) return;
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onSegmentSelectRef.current?.(id);
        });
        onFeature("mousemove", "generated-route-segment-hit-target", (event) => {
          if (!interactionRef.current.selectedRouteId || startAtPoint(event.point)) return;
          const id = event.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          claimHover("segment");
          onSegmentHoverRef.current?.(id);
        });
        onFeature("mouseleave", "generated-route-segment-hit-target", () => {
          if (hoverOwner === "segment") claimHover(undefined);
        });
        let styledTrailId: string | undefined;
        const styleTrailHover = (id?: string) => {
          if (styledTrailId === id) return;
          styledTrailId = id;
          map?.setPaintProperty("trail-network-lines", "line-color", trailNetworkLineColor(id));
          map?.setPaintProperty("trail-network-lines", "line-width", trailNetworkLineWidth(id));
        };
        const clearTrailHover = () => {
          cursorTargets.trail = false;
          syncInteractiveCursor();
          styleTrailHover();
          setHoveredTrail(undefined);
        };
        const clearAccessPointHover = () => {
          cursorTargets.accessPoint = false;
          syncInteractiveCursor();
          map?.setFilter("access-point-hover", EMPTY_ACCESS_POINT_HOVER_FILTER);
          map?.setFilter("access-point-cluster-hover", EMPTY_ACCESS_POINT_CLUSTER_HOVER_FILTER);
          setHoveredAccessPoint(undefined);
        };
        onFeature("mousemove", "trail-network-hit-target", (event) => {
          const priorityLayers = TRAIL_CLICK_PRIORITY_LAYERS.filter((layerId) => map?.getLayer(layerId));
          if (priorityLayers.length > 0 && map?.queryRenderedFeatures(event.point, { layers: priorityLayers }).length) {
            clearTrailHover();
            return;
          }
          const feature = event.features?.[0];
          if (!feature) return;
          const id = feature.properties?.trailGroupId;
          if (typeof id !== "string") return;
          claimHover("trail");
          styleTrailHover(id);
          setHoveredTrail({ id, ...trailNetworkFeatureDetails(feature.properties) });
        });
        onFeature("click", "trail-network-hit-target", (event) => {
          const feature = event.features?.[0];
          const id = feature?.properties?.trailGroupId;
          if (!feature || typeof id !== "string") return;
          const priorityLayers = TRAIL_CLICK_PRIORITY_LAYERS.filter((layerId) => map?.getLayer(layerId));
          if (priorityLayers.length > 0 && map?.queryRenderedFeatures(event.point, { layers: priorityLayers }).length) return;
          const details = trailNetworkFeatureDetails(feature.properties);
          if (!details.copyName) return;
          void copyTextToClipboard(
            details.copyName,
            navigator.clipboard,
            (value) => copyTextWithDocument(value, document),
          ).then((copied) => {
            if (!alive || drawingRef.current) return;
            setHoveredTrail({ id, ...details });
            setMapCopyFeedback({ kind: "trail", id, status: copied ? "copied" : "failed" });
            if (mapCopyTimerRef.current) clearTimeout(mapCopyTimerRef.current);
            mapCopyTimerRef.current = setTimeout(() => {
              setMapCopyFeedback((current) => current?.kind === "trail" && current.id === id ? undefined : current);
              mapCopyTimerRef.current = null;
            }, COPY_FEEDBACK_MS);
          });
        });
        onFeature("mouseleave", "trail-network-hit-target", () => {
          if (hoverOwner === "trail") claimHover(undefined);
        });
        // Clicking a cluster zooms to the level where it breaks apart.
        onFeature("click", "access-point-clusters", (event) => {
          if (startAtPoint(event.point) || routeSegmentAtPoint(event.point) || map?.queryRenderedFeatures(event.point, { layers: ["generated-route-hit-target"] }).length) return;
          const clusterId = event.features?.[0]?.properties?.cluster_id;
          const source = map?.getSource("access-points") as GeoJSONSource | undefined;
          if (typeof clusterId !== "number" || !source) return;
          void source.getClusterExpansionZoom(clusterId).then((zoom) => {
            if (alive && !drawingRef.current) map?.easeTo({ center: event.lngLat, zoom, duration: 350 });
          }).catch(() => undefined);
        });
        onFeature("mouseenter", "access-point-clusters", (event) => {
          if (startAtPoint(event.point) || routeSegmentAtPoint(event.point) || map?.queryRenderedFeatures(event.point, { layers: ["generated-route-hit-target"] }).length) return;
          const clusterId = event.features?.[0]?.properties?.cluster_id;
          const pointCount = event.features?.[0]?.properties?.point_count;
          if (typeof clusterId !== "number") return;
          claimHover("accessPoint");
          map?.setFilter("access-point-cluster-hover", accessPointClusterHoverFilter(clusterId));
          setHoveredAccessPoint({
            id: clusterId,
            kindLabel: "Trailheads",
            name: `${typeof pointCount === "number" ? pointCount : "Multiple"} access points`,
          });
        });
        onFeature("mouseleave", "access-point-clusters", () => {
          if (hoverOwner === "accessPoint") claimHover(undefined);
        });
        onFeature("click", "access-points", (event) => {
          if (startAtPoint(event.point) || routeSegmentAtPoint(event.point) || map?.queryRenderedFeatures(event.point, { layers: ["generated-route-hit-target"] }).length) return;
          const details = accessPointFeatureDetails(event.features?.[0]?.properties);
          if (!details.id) return;
          if (!details.copyName) return;
          void copyTextToClipboard(
            details.copyName,
            navigator.clipboard,
            (value) => copyTextWithDocument(value, document),
          ).then((copied) => {
            if (!alive || drawingRef.current || !details.id) return;
            setHoveredAccessPoint({ id: details.id, kindLabel: details.kindLabel, name: details.name });
            setMapCopyFeedback({ kind: "access-point", id: details.id, status: copied ? "copied" : "failed" });
            if (mapCopyTimerRef.current) clearTimeout(mapCopyTimerRef.current);
            mapCopyTimerRef.current = setTimeout(() => {
              setMapCopyFeedback((current) => current?.kind === "access-point" && current.id === details.id ? undefined : current);
              mapCopyTimerRef.current = null;
            }, COPY_FEEDBACK_MS);
          });
        });
        onFeature("mouseenter", "access-points", (event) => {
          if (startAtPoint(event.point) || routeSegmentAtPoint(event.point) || map?.queryRenderedFeatures(event.point, { layers: ["generated-route-hit-target"] }).length) return;
          const details = accessPointFeatureDetails(event.features?.[0]?.properties);
          if (!details.id) return;
          claimHover("accessPoint");
          map?.setFilter("access-point-hover", accessPointHoverFilter(details.id));
          setHoveredAccessPoint({ id: details.id, kindLabel: details.kindLabel, name: details.name });
        });
        onFeature("mouseleave", "access-points", () => {
          if (hoverOwner === "accessPoint") claimHover(undefined);
        });
        map?.on("movestart", () => {
          moving = true;
          claimHover(undefined);
          closeContextMenu();
        });
        map?.on("moveend", () => { moving = false; });
        // MapLibre forwards the browser event untouched, so the native menu has
        // to be suppressed here or it would cover the one we render.
        map?.on("contextmenu", (event) => {
          event.originalEvent.preventDefault();
          if (drawingRef.current || drawingClickRef.current) return;
          const canvas = map?.getCanvas();
          const position = contextMenuPosition(event.point, {
            width: canvas?.clientWidth ?? 0,
            height: canvas?.clientHeight ?? 0,
          });
          setCoordinateCopyStatus("idle");
          setContextMenu({ ...position, coordinates: formatCoordinates(event.lngLat.lng, event.lngLat.lat) });
        });
        map?.on("click", closeContextMenu);

        const refreshMapData = () => {
          if (!map) return;
          const bounds = map.getBounds();
          trailNetworkController?.abort();
          const controller = new AbortController();
          trailNetworkController = controller;
          styleTrailHover();
          setHoveredTrail(undefined);
          void fetch(mapRequestUrl([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], map.getZoom()), { signal: controller.signal })
            .then(async (response) => {
              if (!response.ok) throw new Error("Trail map data could not be loaded.");
              const next = mapDataSchema.parse(await response.json());
              if (!controller.signal.aborted) { setMapData(next); setMapError(""); }
            }).catch((error: unknown) => {
              if (!controller.signal.aborted) setMapError(error instanceof Error ? error.message : "Trail map data could not be loaded.");
            });
        };
        map?.on("moveend", refreshMapData);
        refreshMapData();
        setMapReady(true);
      });
    });
    return () => {
      alive = false;
      trailNetworkController?.abort();
      resizeObserver?.disconnect();
      previewRoute(undefined);
      onSegmentHoverRef.current?.(undefined);
      clearMapHoverRef.current = undefined;
      map?.remove();
      mapRef.current = null;
      fittedRouteSetRef.current = undefined;
      setMapReady(false);
    };
  }, [closeContextMenu, display.center, display.zoom, previewRoute]);

  useEffect(() => {
    const source = mapRef.current?.getSource("trailhead-filter") as GeoJSONSource | undefined;
    source?.setData(areaFeature(filterGeometry));
    const refinementSource = mapRef.current?.getSource("region-refinement") as GeoJSONSource | undefined;
    refinementSource?.setData(areaFeature(refinementGeometry));
  }, [filterGeometry, refinementGeometry, mapReady]);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    const accessPoints = mapData.accessPoints.filter((point) => includeUncertainAccess || point.accessState !== "unknown");
    (map?.getSource("access-points") as GeoJSONSource | undefined)?.setData(accessPointFeatures(accessPoints, resultAccessPointIds(routes)));
  }, [includeUncertainAccess, mapData.accessPoints, mapReady, routes]);

  useEffect(() => {
    if (!mapReady) return;
    (mapRef.current?.getSource("trail-network") as GeoJSONSource | undefined)?.setData(mapData.trailNetwork);
  }, [mapData.trailNetwork, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("generated-routes") as GeoJSONSource | undefined)?.setData(routeFeatures(routes));
    (map.getSource("generated-starts") as GeoJSONSource | undefined)?.setData(routeStartFeatures(routes));
  }, [mapReady, routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("generated-route-segments") as GeoJSONSource | undefined)?.setData(
      routeSegmentFeatures(selectedRoute),
    );
  }, [mapReady, selectedRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const preview = hoveredRouteId === selectedRouteId ? undefined : hoveredRouteId;
    const focus = preview ?? selectedRouteId;
    map.setFilter("generated-route-alternates", ["!", routeFilter(selectedRouteId)]);
    for (const layer of ["generated-route-selected", "generated-route-selected-casing"]) {
      map.setFilter(layer, routeFilter(selectedRouteId));
      map.setPaintProperty(layer, "line-opacity", preview ? 0.3 : 1);
    }
    for (const layer of ["generated-route-hover", "generated-route-hover-casing"]) map.setFilter(layer, routeFilter(preview));
    map.setPaintProperty("generated-route-alternates", "line-opacity", focus ? 0.2 : selectedStartKey
      ? ["case", ["==", ["get", "startKey"], selectedStartKey], 0.8, 0.16] : 0.8);
    map.setPaintProperty("trail-network-lines", "line-opacity", focus ? 0.35 : 0.65);
    // A segment is meaningful only while its owner is open. Preview temporarily
    // replaces pinned segment emphasis and leaving restores the pinned segment.
    map.setFilter("generated-route-segment-focus", routeFilter(selectedRouteId && !preview ? hoveredSegmentId ?? selectedSegmentId : undefined));
    map.setPaintProperty("generated-route-segment-focus", "line-width", zoomWidth(hoveredSegmentId ? 6 : 5));
  }, [hoveredRouteId, hoveredSegmentId, mapReady, selectedRouteId, selectedSegmentId, selectedStartKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const key = selectedRoute ? routeStart(selectedRoute).key : undefined;
    map.setPaintProperty("generated-starts", "circle-color", [
      "case", ["==", ["get", "key"], key ?? ""], ROUTE_SELECTED, ROUTE_ALTERNATE,
    ]);
    map.setPaintProperty("generated-starts", "circle-stroke-width", [
      "case", ["==", ["get", "key"], selectedStartKey ?? ""], 3, 0,
    ]);
  }, [mapReady, selectedRoute, selectedStartKey]);

  // Framing rules, in priority order:
  //   1. A brand new result set frames every route, so results are never left
  //      as an unreadable speck inside the whole drive-time area.
  //   2. Afterwards, selecting a route only moves the map when that route is
  //      off screen — otherwise walking the results list jitters the view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (routes.length === 0) { fittedRouteSetRef.current = undefined; return; }

    const signature = JSON.stringify(routes.map(({ id }) => id));
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !drawing) return;
    const previewSource = map.getSource("boundary-preview") as GeoJSONSource | undefined;
    const cornerSource = map.getSource("boundary-preview-corners") as GeoJSONSource | undefined;
    const clearPreview = () => {
      previewSource?.setData(EMPTY_POINTS);
      cornerSource?.setData(EMPTY_POINTS);
      draftBoundsRef.current = null;
    };
    const handleDown = (event: MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;
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
      drawingClickRef.current = true;
      changeDrawing(false);
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
      drawingClickRef.current = true;
      changeDrawing(false);
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
  }, [changeDrawing, drawing, mapReady, onBoundsChange]);

  // Escape and any press outside the menu dismiss it; presses on the canvas are
  // already covered by the map's own click handler.
  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return;
      closeContextMenu();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [closeContextMenu, contextMenu]);

  const copyCoordinates = useCallback((coordinates: string) => {
    void copyTextToClipboard(
      coordinates,
      navigator.clipboard,
      (value) => copyTextWithDocument(value, document),
    ).then((copied) => {
      setCoordinateCopyStatus(copied ? "copied" : "failed");
      if (coordinateCopyTimerRef.current) clearTimeout(coordinateCopyTimerRef.current);
      coordinateCopyTimerRef.current = setTimeout(() => {
        coordinateCopyTimerRef.current = null;
        setContextMenu(undefined);
        setCoordinateCopyStatus("idle");
      }, COPY_FEEDBACK_MS);
    });
  }, []);

  const activeTrailCopyFeedback = hoveredTrail && mapCopyFeedback?.kind === "trail" && mapCopyFeedback.id === hoveredTrail.id
    ? mapCopyFeedback
    : undefined;
  const activeAccessPointCopyFeedback = hoveredAccessPoint
    && mapCopyFeedback?.kind === "access-point"
    && mapCopyFeedback.id === hoveredAccessPoint.id
    ? mapCopyFeedback
    : undefined;
  const activeMapCopyFeedback = activeTrailCopyFeedback ?? activeAccessPointCopyFeedback;
  const hoveredMapFeature = hoveredAccessPoint ?? hoveredTrail;

  return (
    <section className={drawing ? "map-shell is-drawing" : "map-shell"} aria-label="Hike search map" aria-busy={!mapReady}>
      <div className="map-toolbar map-toolbar-compact" role="toolbar" aria-label="Draw-area tools">
        <button
          type="button"
          className={`map-tool map-tool-draw${drawing ? " active" : ""}`}
          aria-label={bounds ? "Redraw trailhead filter" : "Draw trailhead filter"}
          aria-pressed={drawing}
          onClick={() => {
            closeContextMenu();
            clearMapHoverRef.current?.();
            changeDrawing(!drawing);
          }}
        >
          {bounds ? "Redraw" : "Draw area"}
        </button>
        <button type="button" className="map-tool map-tool-clear" aria-label="Clear trailhead filter" disabled={!bounds} onClick={() => onBoundsChange(null)}>
          Clear
        </button>
      </div>
      <div ref={containerRef} className="map-canvas" />
      {mapError ? <p className="map-data-error" role="status">{mapError}</p> : null}
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="map-context-menu"
          style={{ left: `${contextMenu.left}px`, top: `${contextMenu.top}px` }}
          role="menu"
          aria-label="Map location"
        >
          <button
            type="button"
            role="menuitem"
            className={`map-context-item${coordinateCopyStatus === "idle" ? "" : ` ${coordinateCopyStatus}`}`}
            onClick={() => copyCoordinates(contextMenu.coordinates)}
          >
            <span className="map-context-action">
              <svg className="map-context-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
                <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1" />
              </svg>
            </span>
            {coordinateCopyStatus === "idle"
              ? <span className="map-context-coordinates">{contextMenu.coordinates}</span>
              : <span className={`map-context-copy-feedback ${coordinateCopyStatus}`}>{coordinateCopyStatus === "copied" ? "Copied" : "Couldn’t copy"}</span>}
            <span className="visually-hidden" aria-live="polite">
              {coordinateCopyStatus === "copied" ? "Coordinates copied" : "Copy coordinates"}
            </span>
          </button>
        </div>
      ) : null}
      <details className="map-key map-key-collapsible">
        <summary className="map-key-toggle">Map key</summary>
        <div className="map-key-content" aria-label="Map symbol explanations">
          {showRegionBoundaries ? <span><i className="key-coverage" aria-hidden="true" />Installed coverage</span> : null}
          {filterGeometry ? <span><i className="key-filter" aria-hidden="true" />Trailhead filter</span> : null}
          {showRegionBoundaries && refinementGeometry ? <span><i className="key-refinement" aria-hidden="true" />Reviewed-region boundary</span> : null}
          <span><i className="key-access" aria-hidden="true" />Trailhead</span>
          <span><i className="key-trail" aria-hidden="true" />Mapped trail</span>
          {routes.length > 0 ? <span><i className="key-route-candidate" aria-hidden="true" />Available route</span> : null}
          {selectedRouteId ? <span><i className="key-route" aria-hidden="true" />Selected route</span> : null}
          {routes.length > 0 ? <span><i className="key-start" aria-hidden="true" />Route start · route count</span> : null}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" aria-label="OpenStreetMap attribution">© OpenStreetMap contributors</a>
        </div>
      </details>
      {drawing || hoveredMapFeature ? <p className={`map-hint${hoveredMapFeature && !drawing ? " map-trail-label" : ""}${activeMapCopyFeedback ? ` ${activeMapCopyFeedback.status}` : ""}`} role="status" aria-live="polite">
        {drawing ? "Draw a trailhead filter. It may extend beyond installed coverage." : <>
          {hoveredAccessPoint ? <>
            {activeAccessPointCopyFeedback ? (
              <span className={`map-trail-distance map-trail-copy-feedback ${activeAccessPointCopyFeedback.status}`}>
                {activeAccessPointCopyFeedback.status === "copied" ? "Copied" : "Couldn’t copy"}
              </span>
            ) : <span className="map-trail-distance">{hoveredAccessPoint.kindLabel}</span>}
            <span>{hoveredAccessPoint.name}</span>
          </> : <>
            {activeTrailCopyFeedback ? (
              <span className={`map-trail-distance map-trail-copy-feedback ${activeTrailCopyFeedback.status}`}>
                {activeTrailCopyFeedback.status === "copied" ? "Copied" : "Couldn’t copy"}
              </span>
            ) : hoveredTrail?.distance ? <span className="map-trail-distance">{hoveredTrail.distance}</span> : null}
            <span>{hoveredTrail?.name}</span>
          </>}
        </>}
      </p> : null}
    </section>
  );
}
