import type {
  GenerateClosedRoutesRequestV3,
  GenerateClosedRoutesResponseV3,
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
  { id: "trailhead-a", name: "Stevens Creek Trailhead", lon: -122.17, lat: 37.16, kind: "trailhead" as const, accessState: "public" as const, confidence: "high" as const, remoteness: "remote" as const },
  { id: "trailhead-b", name: "Canyon Trail Access", lon: -122.16, lat: 37.165, kind: "parking" as const, accessState: "unknown" as const, confidence: "medium" as const, remoteness: "populated" as const },
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

export const REACHABILITY_ID = "db52ceda-c6ef-47f1-9153-dba294a9eccc";

function route(index: number): GeneratedClosedRouteV3 {
  const accessPoint = ACCESS_POINTS[index % ACCESS_POINTS.length]!;
  const repeated = index % 2 === 1;
  return {
    id: `fixture-closed-route-${index}`,
    geometry: {
      type: "LineString",
      coordinates: [
        [accessPoint.lon, accessPoint.lat],
        [-122.145, 37.172],
        [-122.135, 37.175],
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
    warnings: [],
    source: {
      freshness: "2026-08-04T00:00:00Z",
      confidence: "high",
      sourceIds: ["fixture-source"],
    },
  };
}

export function routeResponse(
  request: GenerateClosedRoutesRequestV3,
  count = 1,
): GenerateClosedRoutesResponseV3 {
  const exact = Array.from({ length: count }, (_, index) => route(index));
  const mode = request.accessFilter.mode;
  return {
    version: 3,
    requestId: `browser-${mode}`,
    pack: {
      id: "fixture-pack",
      schemaVersion: "3",
      dataVersion: "fixture-v3",
      builtAt: "2026-08-04T00:00:00Z",
    },
    requested: request.limit,
    resolvedAccessFilter: mode === "drive-time"
      ? {
        mode,
        label: request.accessFilter.regionId
          ? "30 minutes from Castle Rock, refined to Monte Bello Open Space Preserve"
          : "30 minutes from Castle Rock",
        ...(request.accessFilter.regionId ? { region: { id: NAMED_AREA.id, name: NAMED_AREA.name } } : {}),
        driveTime: {
          minutes: 30,
          provider: "arcgis",
          resolvedAt: "2026-08-04T12:00:00Z",
          originLabel: "Castle Rock, California",
        },
      }
      : mode === "named-region"
        ? { mode, label: NAMED_AREA.name, region: { id: NAMED_AREA.id, name: NAMED_AREA.name } }
        : { mode, label: "Drawn trailhead area" },
    exact,
    nearMisses: [],
    diagnostics: {
      elapsedMs: 18,
      expandedStates: 84,
      candidateCount: count,
      eligibleAccessPointCount: 2,
      searchedAccessPointCount: 2,
      graphQueryCount: 2,
      maximumLoadedDirectedEdges: 42,
      exhausted: false,
      truncationReasons: [],
      shortfallReasons: count < request.limit ? ["fewer-diverse-routes-than-requested"] : [],
      noCycleAccessPointCount: 0,
      feasibleAccessPointCount: 2,
      attachmentGroupCount: 1,
      probedAttachmentGroupCount: 1,
      deeplySearchedAttachmentGroupCount: request.searchEffort === "thorough" ? 1 : 0,
      loadedTopologyNetworkCount: 1,
      cycleBlockCount: 1,
      cyclePrimitiveCount: count,
      composedCandidateCount: count,
      repairedCandidateCount: 0,
      directedValidationRejectionCount: 0,
      expandedAssemblyStates: 84,
      timeToFirstExactMs: 8,
      hardTruncationReasons: [],
      nonBudgetShortfallReasons: count < request.limit ? ["fewer-diverse-routes-than-requested"] : [],
    },
  };
}

export function pointInsideArea([lon, lat]: [number, number], area = FILTER_GEOMETRY): boolean {
  const ring = area.coordinates[0];
  const longitudes = ring.map(([x]) => x);
  const latitudes = ring.map(([, y]) => y);
  return lon >= Math.min(...longitudes) && lon <= Math.max(...longitudes)
    && lat >= Math.min(...latitudes) && lat <= Math.max(...latitudes);
}
