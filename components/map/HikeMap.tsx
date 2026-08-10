"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from "geojson";
import type { DataDrivenPropertyValueSpecification, FilterSpecification, Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, GeoJSONSource, Marker } from "maplibre-gl";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts";
import type { AccessPointOption, Bounds } from "../builder/types";
import { boundsCorners, boundsPolygon, normalizeBounds } from "./geometry";
import { ROUTE_PREVIEW_EVENT } from "./routeTraceOverlay";

type HikeMapProps = {
  packIds: string[];
  drawBounds: Bounds | null;
  drawEnabled: boolean;
  filterGeometry?: Polygon | MultiPolygon;
  refinementGeometry?: Polygon | MultiPolygon;
  packCoverageBbox: Bounds;
  packCoverages: Array<Polygon | MultiPolygon>;
  showRegionBoundaries: boolean;
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

/* One hue per meaning: orange is the selection and nothing else; green is
   every unselected route. Weight distinguishes hover and segment focus. */
const ROUTE_SELECTED = "#d83b20";
const ROUTE_ALTERNATE = "#2f6a55";
const ROUTE_WIDTH = 2.5;
const ROUTE_EMPHASIS_WIDTH = 4;
const TRAIL_NETWORK_COLOR = "#3f5f52";
const TRAIL_NETWORK_HOVER_COLOR = "#244c3d";
const TRAIL_NETWORK_WIDTH = 2.4;
const TRAIL_NETWORK_HOVER_WIDTH = 2.7;
export const TRAIL_NETWORK_MIN_ZOOM = 12;
export const TRAIL_COPY_FEEDBACK_MS = 1_500;
export const COORDINATE_COPY_FEEDBACK_MS = 1_500;
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

export function trailNetworkRequestUrl(packId: string, bounds: Bounds, zoom: number): string | undefined {
  if (zoom < TRAIL_NETWORK_MIN_ZOOM) return undefined;
  const query = new URLSearchParams({
    bbox: bounds.join(","),
    includeUncertainAccess: "true",
    includeAccessPoints: "false",
  });
  return `/api/packs/${encodeURIComponent(packId)}/access-points?${query}`;
}

export function trailNetworkRequestUrls(
  packIds: string[],
  bounds: Bounds,
  zoom: number,
): Array<{ packId: string; url: string }> {
  if (zoom < TRAIL_NETWORK_MIN_ZOOM) return [];
  return [...new Set(packIds)].flatMap((packId) => {
    const url = trailNetworkRequestUrl(packId, bounds, zoom);
    return url ? [{ packId, url }] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function mergeTrailNetworkPayloads(
  responses: Array<{ packId: string; payload: unknown }>,
): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: responses.flatMap(({ packId, payload }) => {
      if (!isRecord(payload) || !isRecord(payload.trailNetwork)) return [];
      const trailNetwork = payload.trailNetwork;
      if (trailNetwork.type !== "FeatureCollection" || !Array.isArray(trailNetwork.features)) return [];
      return trailNetwork.features.flatMap((feature): Feature<LineString>[] => {
        if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.geometry)) return [];
        if (feature.geometry.type !== "LineString" || !Array.isArray(feature.geometry.coordinates)) return [];
        const properties = isRecord(feature.properties) ? feature.properties : {};
        const trailGroupId = properties.trailGroupId;
        if (typeof trailGroupId !== "string") return [];
        return [{
          ...(feature as unknown as Feature<LineString>),
          properties: { ...properties, trailGroupId: `${packId}:${trailGroupId}` },
        }];
      });
    }),
  };
}

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

export async function copyTextToClipboard(
  text: string | undefined,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  fallbackCopy?: (value: string) => boolean,
): Promise<boolean> {
  if (!text) return false;
  let clipboardCopy: Promise<boolean> | undefined;
  if (clipboard) {
    try {
      // Start the preferred API while the click's browser activation is live.
      clipboardCopy = clipboard.writeText(text).then(() => true, () => false);
    } catch {
      clipboardCopy = undefined;
    }
  }
  try {
    // Run the compatibility path before this synchronous click stack unwinds.
    if (fallbackCopy?.(text)) {
      void clipboardCopy;
      return true;
    }
  } catch {
    // The preferred API may still succeed when the compatibility path cannot.
  }
  return clipboardCopy ? await clipboardCopy : false;
}

export function copyTextWithDocument(text: string, copyDocument: Document | undefined): boolean {
  if (!copyDocument?.body || typeof copyDocument.execCommand !== "function") return false;
  const activeElement = copyDocument.activeElement;
  const textarea = copyDocument.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px auto auto -9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  copyDocument.body.appendChild(textarea);
  textarea.select();
  try {
    return copyDocument.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (activeElement && "focus" in activeElement) (activeElement as HTMLElement).focus({ preventScroll: true });
  }
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

// A selected numbered pin is about 22px wide. Split a cluster as soon as its
// centers clear that footprint, so numbering returns before deep trail zooms.
export const ROUTE_PIN_CLUSTER_RADIUS_PX = 22;
export const ROUTE_PIN_NUMBER_MIN_ZOOM = 11;

type RoutePinScreenPoint = { x: number; y: number };

const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };

function areaFeature(geometry?: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> | FeatureCollection<Point> {
  return geometry ? { type: "Feature", properties: { role: "trailhead-filter" }, geometry } : EMPTY_POINTS;
}

export function packCoverageFeatures(
  packCoverages: Array<Polygon | MultiPolygon>,
): FeatureCollection<Polygon | MultiPolygon> {
  return {
    type: "FeatureCollection",
    features: packCoverages.map((geometry) => ({
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
  selectedAccessPointId?: string,
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

export function clusterRouteTrailheadPins(
  pins: RouteTrailheadPin[],
  selectedRouteId: string | undefined,
  project: (coordinates: [number, number]) => RoutePinScreenPoint,
  radiusPx = ROUTE_PIN_CLUSTER_RADIUS_PX,
): RouteTrailheadPin[] {
  if (pins.length < 2) return pins;

  // Result sets contain at most 20 routes, so a small connected-components
  // pass keeps grouping deterministic while allowing a chain of nearby starts
  // to read as one cluster at low zoom.
  const screenPoints = pins.map((pin) => project(pin.coordinates));
  const parents = pins.map((_, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]!]!;
      current = parents[current]!;
    }
    return current;
  };
  const join = (left: number, right: number) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (let left = 0; left < pins.length; left += 1) {
    for (let right = left + 1; right < pins.length; right += 1) {
      const dx = screenPoints[left]!.x - screenPoints[right]!.x;
      const dy = screenPoints[left]!.y - screenPoints[right]!.y;
      if ((dx * dx) + (dy * dy) <= radiusPx * radiusPx) join(left, right);
    }
  }

  const groups = new Map<number, number[]>();
  pins.forEach((_, index) => {
    const groupRoot = root(index);
    groups.set(groupRoot, [...(groups.get(groupRoot) ?? []), index]);
  });

  return [...groups.values()].map((indexes) => {
    if (indexes.length === 1) return pins[indexes[0]!]!;

    const members = indexes
      .flatMap((index) => pins[index]!.routeNumbers.map((routeNumber, routeIndex) => ({
        routeNumber,
        routeId: pins[index]!.routeIds[routeIndex]!,
      })))
      .sort((left, right) => left.routeNumber - right.routeNumber);
    const routeIds = members.map(({ routeId }) => routeId);
    const routeNumbers = members.map(({ routeNumber }) => routeNumber);
    const selectedIndex = selectedRouteId ? routeIds.indexOf(selectedRouteId) : -1;
    const center = indexes.reduce<RoutePinScreenPoint>((total, index) => ({
      x: total.x + screenPoints[index]!.x / indexes.length,
      y: total.y + screenPoints[index]!.y / indexes.length,
    }), { x: 0, y: 0 });
    const selectedPinIndex = indexes.find((index) => pins[index]!.selected);
    const anchorIndex = selectedPinIndex ?? indexes.reduce((closest, index) => {
      const closestDistance = ((screenPoints[closest]!.x - center.x) ** 2) + ((screenPoints[closest]!.y - center.y) ** 2);
      const distance = ((screenPoints[index]!.x - center.x) ** 2) + ((screenPoints[index]!.y - center.y) ** 2);
      return distance < closestDistance ? index : closest;
    });
    const names = [...new Set(indexes.map((index) => pins[index]!.name))];

    return {
      key: `cluster:${indexes.map((index) => pins[index]!.key).sort().join("|")}`,
      // A cluster is a summary, but its anchor must still be geographically
      // honest. Prefer the selected start, otherwise the member closest to the
      // group center; never invent a midpoint where no route starts.
      coordinates: pins[anchorIndex]!.coordinates,
      name: names.join(", "),
      routeIds,
      routeNumbers,
      numberLabel: numberLabel(routeNumbers),
      selected: selectedIndex >= 0,
      nextRouteId: selectedIndex >= 0
        ? routeIds[(selectedIndex + 1) % routeIds.length]!
        : routeIds[0]!,
    };
  });
}

export function HikeMap({
  packIds,
  drawBounds: bounds,
  drawEnabled,
  filterGeometry,
  refinementGeometry,
  packCoverages,
  packCoverageBbox,
  showRegionBoundaries,
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
  const packIdsRef = useRef(packIds);
  const packCoveragesRef = useRef(packCoverages);
  const showRegionBoundariesRef = useRef(showRegionBoundaries);
  const refreshTrailNetworkRef = useRef<(() => void) | null>(null);
  const selectedAccessPointIdRef = useRef(selectedAccessPointId);
  const routesRef = useRef(routes);
  const selectedRouteIdRef = useRef(selectedRouteId);
  const selectedSegmentIdRef = useRef(selectedSegmentId);
  const hoveredSegmentIdRef = useRef(hoveredSegmentId);
  const filterGeometryRef = useRef(filterGeometry);
  const refinementGeometryRef = useRef(refinementGeometry);
  const mapCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coordinateCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [hoveredRouteId, setHoveredRouteId] = useState<string>();
  const [hoveredTrail, setHoveredTrail] = useState<HoveredTrail>();
  const [hoveredAccessPoint, setHoveredAccessPoint] = useState<HoveredAccessPoint>();
  const [mapCopyFeedback, setMapCopyFeedback] = useState<MapCopyFeedback>();
  const [contextMenu, setContextMenu] = useState<MapContextMenu>();
  const [coordinateCopyStatus, setCoordinateCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [mapReady, setMapReady] = useState(false);
  const packIdsKey = packIds.join("\u0000");

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
    packIdsRef.current = packIds;
  }, [packIds]);

  useEffect(() => {
    refreshTrailNetworkRef.current?.();
  }, [packIdsKey]);

  useEffect(() => {
    packCoveragesRef.current = packCoverages;
    const source = mapRef.current?.getSource("pack-coverage") as GeoJSONSource | undefined;
    source?.setData(packCoverageFeatures(packCoverages));
  }, [packCoverages]);

  useEffect(() => {
    showRegionBoundariesRef.current = showRegionBoundaries;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const visibility = regionBoundaryVisibility(showRegionBoundaries);
    if (map.getLayer("pack-coverage-line")) map.setLayoutProperty("pack-coverage-line", "visibility", visibility);
    if (map.getLayer("region-refinement-line")) map.setLayoutProperty("region-refinement-line", "visibility", visibility);
  }, [mapReady, showRegionBoundaries]);

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
        map?.addSource("pack-coverage", { type: "geojson", data: packCoverageFeatures(packCoveragesRef.current) });
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
        map?.addSource("trail-network", { type: "geojson", data: trailNetworkRef.current });
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
          data: accessPointFeatures(
            accessPointsRef.current,
            selectedAccessPointIdRef.current,
            resultAccessPointIds(routesRef.current),
          ),
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
            "circle-color": [
              "case",
              ["==", ["get", "selected"], true], ROUTE_SELECTED,
              "#173f35",
            ],
          },
        });
        map?.addLayer({
          id: "access-point-hover",
          type: "circle",
          source: "access-points",
          filter: EMPTY_ACCESS_POINT_HOVER_FILTER,
          paint: {
            "circle-radius": zoomWidth(7.5),
            "circle-color": [
              "case",
              ["==", ["get", "selected"], true], ROUTE_SELECTED,
              "#173f35",
            ],
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
        // route is orange. Result routes have no casing or background stroke.
        map?.addLayer({
          id: "generated-route-alternates",
          type: "line",
          source: "generated-route-alternates",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_ALTERNATE, "line-width": zoomWidth(ROUTE_WIDTH), "line-opacity": 1 },
        });
        map?.addLayer({
          id: "generated-route-hover",
          type: "line",
          source: "generated-route-hover",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_ALTERNATE, "line-width": zoomWidth(ROUTE_EMPHASIS_WIDTH) },
        });
        map?.addLayer({
          id: "generated-route-selected",
          type: "line",
          source: "generated-route-selected",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_SELECTED, "line-width": zoomWidth(ROUTE_WIDTH), "line-opacity": 1 },
        });
        map?.addLayer({
          id: "generated-route-segment-focus",
          type: "line",
          source: "generated-route-segment-focus",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_SELECTED, "line-width": zoomWidth(ROUTE_EMPHASIS_WIDTH) },
        });
        map?.addLayer({
          id: "generated-route-hit-target",
          type: "line",
          source: "generated-routes-hit",
          // MapLibre hit testing uses line geometry and width, not opacity, so
          // this can be truly invisible without shrinking its pointer target.
          paint: { "line-color": "#000000", "line-width": 14, "line-opacity": 0 },
        });
        map?.addLayer({
          id: "generated-route-segment-hit-target",
          type: "line",
          source: "generated-route-segments-hit",
          paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 },
        });
        const cursorTargets = { route: false, segment: false, trail: false, accessPoint: false };
        const syncInteractiveCursor = () => {
          const canvas = map?.getCanvas();
          if (!canvas) return;
          if (Object.values(cursorTargets).some(Boolean)) canvas.style.setProperty("cursor", "pointer");
          else canvas.style.removeProperty("cursor");
        };
        const routeSegmentAtPoint = (point: MapLayerMouseEvent["point"]) => Boolean(
          map?.queryRenderedFeatures(point, { layers: ["generated-route-segment-hit-target"] }).length,
        );
        const selectRoute = (event: MapLayerMouseEvent) => {
          if (routeSegmentAtPoint(event.point)) return;
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onRouteSelectRef.current(id);
        };
        map?.on("click", "generated-route-hit-target", selectRoute);
        map?.on("mousemove", "generated-route-hit-target", (event) => {
          if (routeSegmentAtPoint(event.point)) {
            cursorTargets.route = false;
            syncInteractiveCursor();
            previewRoute(undefined);
            return;
          }
          const id = event.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          cursorTargets.route = true;
          syncInteractiveCursor();
          previewRoute(id);
        });
        map?.on("mouseleave", "generated-route-hit-target", () => {
          cursorTargets.route = false;
          syncInteractiveCursor();
          previewRoute(undefined);
        });
        map?.on("click", "generated-route-segment-hit-target", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onSegmentSelectRef.current?.(id);
        });
        map?.on("mousemove", "generated-route-segment-hit-target", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          cursorTargets.segment = true;
          syncInteractiveCursor();
          onSegmentHoverRef.current?.(id);
        });
        map?.on("mouseleave", "generated-route-segment-hit-target", () => {
          cursorTargets.segment = false;
          syncInteractiveCursor();
          onSegmentHoverRef.current?.(undefined);
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
        map?.on("mousemove", "trail-network-hit-target", (event) => {
          const priorityLayers = TRAIL_CLICK_PRIORITY_LAYERS.filter((layerId) => map?.getLayer(layerId));
          if (priorityLayers.length > 0 && map?.queryRenderedFeatures(event.point, { layers: priorityLayers }).length) {
            clearTrailHover();
            return;
          }
          const feature = event.features?.[0];
          if (!feature) return;
          const id = feature.properties?.trailGroupId;
          if (typeof id !== "string") return;
          cursorTargets.trail = true;
          syncInteractiveCursor();
          styleTrailHover(id);
          setHoveredTrail({ id, ...trailNetworkFeatureDetails(feature.properties) });
        });
        map?.on("click", "trail-network-hit-target", (event) => {
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
            if (!alive) return;
            setHoveredTrail({ id, ...details });
            setMapCopyFeedback({ kind: "trail", id, status: copied ? "copied" : "failed" });
            if (mapCopyTimerRef.current) clearTimeout(mapCopyTimerRef.current);
            mapCopyTimerRef.current = setTimeout(() => {
              setMapCopyFeedback((current) => current?.kind === "trail" && current.id === id ? undefined : current);
              mapCopyTimerRef.current = null;
            }, TRAIL_COPY_FEEDBACK_MS);
          });
        });
        map?.on("mouseleave", "trail-network-hit-target", clearTrailHover);
        // Clicking a cluster zooms to the level where it breaks apart.
        map?.on("click", "access-point-clusters", (event) => {
          const clusterId = event.features?.[0]?.properties?.cluster_id;
          const source = map?.getSource("access-points") as GeoJSONSource | undefined;
          if (typeof clusterId !== "number" || !source) return;
          void source.getClusterExpansionZoom(clusterId).then((zoom) => {
            map?.easeTo({ center: event.lngLat, zoom, duration: 350 });
          }).catch(() => undefined);
        });
        map?.on("mouseenter", "access-point-clusters", (event) => {
          const clusterId = event.features?.[0]?.properties?.cluster_id;
          const pointCount = event.features?.[0]?.properties?.point_count;
          if (typeof clusterId !== "number") return;
          clearTrailHover();
          cursorTargets.accessPoint = true;
          syncInteractiveCursor();
          map?.setFilter("access-point-cluster-hover", accessPointClusterHoverFilter(clusterId));
          setHoveredAccessPoint({
            id: clusterId,
            kindLabel: "Trailheads",
            name: `${typeof pointCount === "number" ? pointCount : "Multiple"} access points`,
          });
        });
        map?.on("mouseleave", "access-point-clusters", () => {
          clearAccessPointHover();
        });
        map?.on("click", "access-points", (event) => {
          const details = accessPointFeatureDetails(event.features?.[0]?.properties);
          if (!details.id) return;
          onAccessPointSelectRef.current(details.id);
          if (!details.copyName) return;
          void copyTextToClipboard(
            details.copyName,
            navigator.clipboard,
            (value) => copyTextWithDocument(value, document),
          ).then((copied) => {
            if (!alive || !details.id) return;
            setHoveredAccessPoint({ id: details.id, kindLabel: details.kindLabel, name: details.name });
            setMapCopyFeedback({ kind: "access-point", id: details.id, status: copied ? "copied" : "failed" });
            if (mapCopyTimerRef.current) clearTimeout(mapCopyTimerRef.current);
            mapCopyTimerRef.current = setTimeout(() => {
              setMapCopyFeedback((current) => current?.kind === "access-point" && current.id === details.id ? undefined : current);
              mapCopyTimerRef.current = null;
            }, TRAIL_COPY_FEEDBACK_MS);
          });
        });
        map?.on("mouseenter", "access-points", (event) => {
          const details = accessPointFeatureDetails(event.features?.[0]?.properties);
          if (!details.id) return;
          clearTrailHover();
          cursorTargets.accessPoint = true;
          syncInteractiveCursor();
          map?.setFilter("access-point-hover", accessPointHoverFilter(details.id));
          setHoveredAccessPoint({ id: details.id, kindLabel: details.kindLabel, name: details.name });
        });
        map?.on("mouseleave", "access-points", () => {
          clearAccessPointHover();
        });
        map?.on("movestart", () => {
          cursorTargets.route = false;
          cursorTargets.segment = false;
          clearTrailHover();
          clearAccessPointHover();
          syncInteractiveCursor();
          closeContextMenu();
        });
        // MapLibre forwards the browser event untouched, so the native menu has
        // to be suppressed here or it would cover the one we render.
        map?.on("contextmenu", (event) => {
          event.originalEvent.preventDefault();
          const canvas = map?.getCanvas();
          const position = contextMenuPosition(event.point, {
            width: canvas?.clientWidth ?? 0,
            height: canvas?.clientHeight ?? 0,
          });
          setCoordinateCopyStatus("idle");
          setContextMenu({ ...position, coordinates: formatCoordinates(event.lngLat.lng, event.lngLat.lat) });
        });
        map?.on("click", closeContextMenu);

        const refreshTrailNetwork = () => {
          if (!map) return;
          const visibleBounds = map.getBounds();
          const requests = trailNetworkRequestUrls(packIdsRef.current, [
            visibleBounds.getWest(),
            visibleBounds.getSouth(),
            visibleBounds.getEast(),
            visibleBounds.getNorth(),
          ], map.getZoom());
          trailNetworkController?.abort();
          trailNetworkController = null;
          styleTrailHover();
          setHoveredTrail(undefined);
          const source = map.getSource("trail-network") as GeoJSONSource | undefined;
          if (requests.length === 0) {
            source?.setData(EMPTY_LINES);
            return;
          }
          const controller = new AbortController();
          trailNetworkController = controller;
          void Promise.allSettled(requests.map(async ({ packId, url }) => {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`Trail network request failed: ${response.status}`);
            return { packId, payload: await response.json() as unknown };
          })).then((results) => {
            if (controller.signal.aborted) return;
            const successfulPayloads = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
            source?.setData(mergeTrailNetworkPayloads(successfulPayloads));
          });
        };
        refreshTrailNetworkRef.current = refreshTrailNetwork;
        map?.on("moveend", refreshTrailNetwork);
        refreshTrailNetwork();
        setMapReady(true);
      });
    });
    return () => {
      alive = false;
      trailNetworkController?.abort();
      refreshTrailNetworkRef.current = null;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [closeContextMenu, display.center, display.zoom, packCoverageBbox, previewRoute]);

  useEffect(() => {
    const source = mapRef.current?.getSource("trailhead-filter") as GeoJSONSource | undefined;
    source?.setData(areaFeature(filterGeometry));
    const refinementSource = mapRef.current?.getSource("region-refinement") as GeoJSONSource | undefined;
    refinementSource?.setData(areaFeature(refinementGeometry));
  }, [filterGeometry, refinementGeometry]);

  useEffect(() => {
    const source = mapRef.current?.getSource("access-points") as GeoJSONSource | undefined;
    source?.setData(accessPointFeatures(accessPoints, selectedAccessPointId, resultAccessPointIds(routes)));
  }, [accessPoints, routes, selectedAccessPointId]);

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
  }, [hoveredRouteId, hoveredSegmentId, mapReady, routes, selectedRouteId, selectedSegmentId]);

  // Numbered start pins are DOM markers rather than a symbol layer: the style
  // ships no glyph endpoint, so map-rendered text would never appear at all.
  useEffect(() => {
    const map = mapRef.current;
    const MarkerFactory = markerFactoryRef.current;
    if (!map || !mapReady || !MarkerFactory) return;
    let markers: Marker[] = [];
    const clearMarkers = () => {
      markers.forEach((marker) => marker.remove());
      markers = [];
      markersRef.current = [];
    };
    const renderMarkers = () => {
      clearMarkers();
      const numbered = map.getZoom() >= ROUTE_PIN_NUMBER_MIN_ZOOM;
      const exactPins = routeTrailheadPins(routes, selectedRouteId);
      const pins = numbered
        ? exactPins
        : clusterRouteTrailheadPins(exactPins, selectedRouteId, (coordinates) => map.project(coordinates));
      markers = pins.map((pin) => {
        if (numbered && pin.routeIds.length > 1) {
          const anchor = document.createElement("div");
          anchor.className = "route-pin-expanded";
          const grid = document.createElement("div");
          grid.className = pin.routeIds.length > 4 ? "route-pin-expanded-grid many" : "route-pin-expanded-grid";
          pin.routeIds.forEach((routeId, index) => {
            const routeNumber = pin.routeNumbers[index]!;
            const element = document.createElement("button");
            element.type = "button";
            element.className = ["route-pin", routeId === selectedRouteId ? "selected" : ""].filter(Boolean).join(" ");
            element.textContent = String(routeNumber);
            element.title = pin.name;
            element.setAttribute("aria-label", `Route ${routeNumber} start at ${pin.name}`);
            element.addEventListener("click", (event) => { event.stopPropagation(); onRouteSelectRef.current(routeId); });
            element.addEventListener("mouseenter", () => previewRoute(routeId));
            element.addEventListener("mouseleave", () => previewRoute(undefined));
            grid.append(element);
          });
          const tip = document.createElement("span");
          tip.className = pin.selected ? "route-pin-tip selected" : "route-pin-tip";
          tip.setAttribute("aria-hidden", "true");
          anchor.append(grid, tip);
          return new MarkerFactory({ element: anchor, anchor: "bottom", subpixelPositioning: true }).setLngLat(pin.coordinates).addTo(map);
        }

        // MapLibre writes its positioning transform onto the element it is
        // given, so only the button inside the anchor may animate.
        const anchor = document.createElement("div");
        anchor.className = "route-pin-anchor";
        const element = document.createElement("button");
        const overview = !numbered;
        const groupedOverview = overview && pin.routeIds.length > 1;
        const groupSize = pin.routeIds.length > 9 ? "dense" : pin.routeIds.length > 4 ? "many" : "";
        element.type = "button";
        element.className = [
          "route-pin",
          pin.selected ? "selected" : "",
          groupedOverview ? "overview" : "",
          groupedOverview ? groupSize : pin.numberLabel.length > 3 ? "wide" : "",
        ].filter(Boolean).join(" ");
        element.textContent = groupedOverview ? "" : pin.numberLabel;
        element.title = groupedOverview ? `${pin.routeIds.length} results near ${pin.name}` : pin.name;
        element.setAttribute(
          "aria-label",
          groupedOverview
            ? `${pin.routeIds.length} result starts near ${pin.name}`
            : `Route ${pin.numberLabel} start at ${pin.name}`,
        );
        element.addEventListener("click", (event) => { event.stopPropagation(); onRouteSelectRef.current(pin.nextRouteId); });
        element.addEventListener("mouseenter", () => previewRoute(pin.selected ? selectedRouteId : pin.routeIds[0]));
        element.addEventListener("mouseleave", () => previewRoute(undefined));
        anchor.append(element);
        return new MarkerFactory({ element: anchor, anchor: "center", subpixelPositioning: true }).setLngLat(pin.coordinates).addTo(map);
      });
      markersRef.current = markers;
    };

    renderMarkers();
    map.on("zoomend", renderMarkers);
    return () => {
      map.off("zoomend", renderMarkers);
      clearMarkers();
    };
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
      }, COORDINATE_COPY_FEEDBACK_MS);
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
      <div ref={containerRef} className="map-canvas" />
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
          {routes.length > 0 ? <span><i className="key-route" aria-hidden="true" />Suggested route</span> : null}
          {routes.length > 0 ? <span><i className="key-start" aria-hidden="true" />Route start</span> : null}
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
