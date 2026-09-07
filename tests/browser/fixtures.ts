import type { SearchRequest, SearchResult } from "../../lib/contracts/search";
import type {
  GeneratedClosedRouteV3,
  NamedArea,
  NamedAreaSummary,
} from "../../lib/contracts";

type PolygonGeometry = Extract<NamedArea["geometry"], { type: "Polygon" }>;

export const PACK_COVERAGE: PolygonGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.19, 37.15], [-122.13, 37.15], [-122.13, 37.18],
    [-122.19, 37.18], [-122.19, 37.15],
  ]],
};

export const FILTER_GEOMETRY: PolygonGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.18, 37.155], [-122.155, 37.155], [-122.155, 37.17],
    [-122.18, 37.17], [-122.18, 37.155],
  ]],
};

export const REFINEMENT_GEOMETRY: PolygonGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.175, 37.157], [-122.158, 37.157], [-122.158, 37.168],
    [-122.175, 37.168], [-122.175, 37.157],
  ]],
};

export const NAMED_AREA_SUMMARY: NamedAreaSummary = {
  id: "osm-relation-4242",
  name: "Monte Bello Open Space Preserve",
  kind: "preserve",
  context: "Santa Clara County",
  bbox: [-122.18, 37.155, -122.155, 37.17],
  sourceIds: ["openstreetmap:relation:4242"],
};

export const NAMED_AREA: NamedArea = { ...NAMED_AREA_SUMMARY, geometry: FILTER_GEOMETRY };

export const ACCESS_POINTS = [
  { id: "trailhead-a", name: "Stevens Creek Trailhead", lon: -122.17, lat: 37.16, kind: "trailhead" as const, accessState: "public" as const, confidence: "high" as const },
  { id: "trailhead-b", name: "Canyon Trail Access", lon: -122.16, lat: 37.165, kind: "parking" as const, accessState: "unknown" as const, confidence: "medium" as const },
];

export const TRAIL_NETWORK = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    properties: { id: "trail-fixture", name: "Canyon Trail" },
    geometry: {
      type: "LineString" as const,
      coordinates: [[-122.17, 37.16], [-122.145, 37.172], [-122.135, 37.175]],
    },
  }],
};

function route(index: number): GeneratedClosedRouteV3 {
  const accessPoint = ACCESS_POINTS[index % ACCESS_POINTS.length]!;
  const repeated = index % 2 === 1;
  const routeVariation = index * 0.00001;
  return {
    id: `fixture-closed-route-${index}`,
    geometry: {
      type: "LineString",
      coordinates: [
        [accessPoint.lon, accessPoint.lat],
        [-122.145 + routeVariation, 37.172],
        [-122.135 + routeVariation, 37.175],
        [accessPoint.lon, accessPoint.lat],
      ],
    },
    startAccessPoint: {
      id: accessPoint.id,
      name: accessPoint.name,
      lon: accessPoint.lon,
      lat: accessPoint.lat,
      accessState: accessPoint.accessState,
      confidence: accessPoint.confidence,
    },
    distanceMeters: 4_200 + index * 100,
    elevationGainMeters: 280,
    elevationLossMeters: 280,
    minimumElevationMeters: 410,
    maximumElevationMeters: 690,
    steepestSustainedGradePct: 11.4,
    topology: {
      kind: repeated ? "lollipop" : "simple-loop",
      cycleCount: 1,
      cycleBlockCount: 1,
      repeatedTrailDistanceMeters: repeated ? 420 : 0,
      repeatedTrailFraction: repeated ? 0.1 : 0,
      sharedStemDistanceMeters: repeated ? 210 : 0,
      connectorCount: repeated ? 1 : 0,
    },
    trailNames: [`Canyon Trail ${index + 1}`],
    trailSegments: [{
      id: `fixture-closed-route-${index}:segment:1`,
      geometry: {
        type: "LineString",
        coordinates: [[accessPoint.lon, accessPoint.lat], [-122.145 + routeVariation, 37.172]],
      },
      name: `Canyon Trail ${index + 1}`,
      distanceMeters: 2_800,
      startDistanceMeters: 0,
      endDistanceMeters: 2_800,
      accessState: accessPoint.accessState,
      condition: { highway: "path", surface: "dirt", trailVisibility: "good" },
      sourceFeatureId: `way/${100 + index}`,
      sourceIds: ["fixture-source"],
    }, {
      id: `fixture-closed-route-${index}:segment:2`,
      geometry: {
        type: "LineString",
        coordinates: [[-122.145 + routeVariation, 37.172], [-122.135 + routeVariation, 37.175], [accessPoint.lon, accessPoint.lat]],
      },
      name: null,
      distanceMeters: 1_400 + index * 100,
      startDistanceMeters: 2_800,
      endDistanceMeters: 4_200 + index * 100,
      accessState: "unknown",
      condition: { highway: "path" },
      sourceFeatureId: `way/${200 + index}`,
      sourceIds: ["fixture-source"],
    }],
    warnings: [],
    source: {
      freshness: "2026-08-04T00:00:00Z",
      confidence: "high",
      sourceIds: ["fixture-source"],
    },
  };
}

export function routeResponse(request: SearchRequest, count = 1): SearchResult {
  return {
    request,
    area: {
      label: request.area.mode === "drawn-area" ? "Drawn search area" : NAMED_AREA.name,
      filterGeometry: request.area.mode === "drawn-area" ? {
        type: "Polygon", coordinates: [[[request.area.bbox[0], request.area.bbox[1]], [request.area.bbox[2], request.area.bbox[1]], [request.area.bbox[2], request.area.bbox[3]], [request.area.bbox[0], request.area.bbox[3]], [request.area.bbox[0], request.area.bbox[1]]]],
      } : FILTER_GEOMETRY,
      ...(request.area.mode === "drive-time" && request.area.regionIds.length ? { refinementGeometry: REFINEMENT_GEOMETRY } : {}),
    },
    exact: Array.from({ length: count }, (_, index) => ({ ...route(index), regionLabel: NAMED_AREA.name })),
    nearMisses: [], incomplete: false, messages: [],
  };
}

export function pointInsideArea([lon, lat]: [number, number], area = FILTER_GEOMETRY): boolean {
  const ring = area.coordinates[0];
  const longitudes = ring.map(([x]) => x);
  const latitudes = ring.map(([, y]) => y);
  return lon >= Math.min(...longitudes) && lon <= Math.max(...longitudes)
    && lat >= Math.min(...latitudes) && lat <= Math.max(...latitudes);
}
