// ArcGIS four- and five-hour service areas can legitimately contain more than
// 50,000 vertices. These limits remain bounded, while accommodating the real
// provider contours used by the product.
export const MAX_TRAIL_SEARCH_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_TRAIL_SEARCH_VERTICES = 200_000;
export const MAX_TRAIL_SEARCH_RESPONSE_BYTES = 448 * 1024;
export const MAX_TRAIL_SEARCH_RESULTS = 500;
export const MAX_REPRESENTATIVE_ACCESS_POINTS = 2;
export const ACCESS_POINT_EQUIVALENCE_METERS = 25;

export type SourceRef = {
  provider: string;
  sourceId: string;
  sourceUpdatedAt?: string;
  retrievedAt: string;
  sourceUrl: string;
};

export type TrailSegment = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  displayGeometry?: { type: "LineString"; coordinates: [number, number][] };
  name?: string;
  manager?: string;
  hiking: "allowed" | "blocked" | "unknown";
  access: "public" | "private" | "unknown";
  status: "open" | "closed" | "seasonal" | "unknown";
  surface?: string;
  lengthMeters: number;
  ascentForwardMeters?: number;
  descentForwardMeters?: number;
  minElevationMeters?: number;
  maxElevationMeters?: number;
  maxGradePct?: number;
  sourceRefs: SourceRef[];
};

export type NamedTrailRecord = {
  id: string;
  name: string;
  segmentIds: string[];
  accessPointIds: string[];
  manager?: string;
  bounds: [number, number, number, number];
  lengthMeters?: number;
  sourceRefs: SourceRef[];
  dataConfidence: "high" | "medium" | "low";
};

export type TrailSearchSummary = {
  hiking: "allowed" | "blocked" | "unknown";
  access: "public" | "private" | "unknown";
  status: "open" | "closed" | "seasonal" | "unknown";
  surfaces?: string[];
  elevation?: { minMeters: number; maxMeters: number };
  routeClass: "hiking" | "advanced-climbing";
  notices?: string[];
  suppressed?: boolean;
  suppressionReason?: string;
};

export type AccessPointFeature = {
  type: "Feature";
  id?: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name?: string;
    type: "trailhead" | "entrance" | "parking" | "derived";
    confidence: "official" | "mapped" | "derived";
    connectedNodeIds: string[];
    sourceRefs: SourceRef[];
  };
};

export type RegionalTrailCatalog = {
  manifest: {
    schemaVersion: number;
    buildId?: string;
    generatedAt: string;
    region: {
      id: string;
      label: string;
      bounds: [number, number, number, number];
    };
    artifacts?: Record<string, {
      path?: string;
      records?: number;
      rawBytes?: number;
      compressedBytes?: number;
      sha256?: string;
      role?: "runtime" | "diagnostic";
      application?: "required" | "optional";
    }>;
  };
  namedTrails: NamedTrailRecord[];
  accessPoints: AccessPointFeature[];
  summaries: Record<string, TrailSearchSummary>;
  shardPaths: Record<string, string>;
  partitionPrefixLength: number;
  trailGeometryPaths?: Record<string, string>;
};

export type TrailAccessPointMetadata = {
  id: string;
  name?: string;
  type: AccessPointFeature["properties"]["type"];
  confidence: AccessPointFeature["properties"]["confidence"];
  longitude: number;
  latitude: number;
  sourceRefs: SourceRef[];
};

export type TrailAccessPointDetail = TrailAccessPointMetadata & {
  connectedNodeIds: string[];
};

type Position = [number, number];
type PolygonGeometry = { type: "Polygon"; coordinates: Position[][] };
type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Position[][][] };
export type DriveTimeGeometry = PolygonGeometry | MultiPolygonGeometry;

type PreparedRingEdge = {
  start: Position;
  end: Position;
  minimumLongitude: number;
  minimumLatitude: number;
  maximumLongitude: number;
  maximumLatitude: number;
};

type PreparedRing = {
  edges: PreparedRingEdge[];
  latitudeBins: number[][];
  spanningEdgeIndexes: number[];
  minimumLongitude: number;
  minimumLatitude: number;
  maximumLongitude: number;
  maximumLatitude: number;
};

type PreparedPolygon = {
  outer: PreparedRing;
  holes: PreparedRing[];
};

export type PreparedDriveTimeGeometry = {
  polygons: PreparedPolygon[];
};

export type PreparedGeometryStats = {
  candidateEdges: number;
  edgeChecks: number;
  boundsRejected: number;
};

export type TrailSearchRequest = {
  regionId: string;
  driveTimePolygon: DriveTimeGeometry;
  query?: string;
  limit: number;
};

type ParseResult =
  | { ok: true; request: TrailSearchRequest }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validPosition(value: unknown): value is Position {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function validRing(value: unknown): value is Position[] {
  if (!Array.isArray(value) || value.length < 4 || !value.every(validPosition)) return false;
  const first = value[0];
  const last = value.at(-1)!;
  return first[0] === last[0] && first[1] === last[1];
}

function validPolygonCoordinates(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(validRing);
}

function polygonGeometries(value: unknown): PolygonGeometry[] | null {
  if (!isObject(value) || typeof value.type !== "string") return null;
  if (value.type === "Feature") return polygonGeometries(value.geometry);
  if (value.type === "FeatureCollection") {
    if (!Array.isArray(value.features) || value.features.length === 0) return null;
    const polygons = value.features.flatMap((feature) => polygonGeometries(feature) ?? []);
    return polygons.length > 0 ? polygons : null;
  }
  if (value.type === "Polygon") {
    return validPolygonCoordinates(value.coordinates)
      ? [{ type: "Polygon", coordinates: value.coordinates }]
      : null;
  }
  if (value.type === "MultiPolygon") {
    if (!Array.isArray(value.coordinates) || value.coordinates.length === 0 ||
        !value.coordinates.every(validPolygonCoordinates)) return null;
    return value.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  }
  return null;
}

function vertexCount(polygons: PolygonGeometry[]) {
  return polygons.reduce((total, polygon) => total + polygon.coordinates.reduce(
    (polygonTotal, ring) => polygonTotal + ring.length,
    0,
  ), 0);
}

export function normalizeDriveTimeGeometry(value: unknown): DriveTimeGeometry | null {
  const polygons = polygonGeometries(value);
  if (!polygons || vertexCount(polygons) > MAX_TRAIL_SEARCH_VERTICES) return null;
  if (polygons.length === 1) return polygons[0];
  return { type: "MultiPolygon", coordinates: polygons.map(({ coordinates }) => coordinates) };
}

export function parseTrailSearchRequest(value: unknown): ParseResult {
  if (!isObject(value)) return { ok: false, error: "The request body must be an object." };
  if (typeof value.regionId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.regionId)) {
    return { ok: false, error: "A valid regionId is required." };
  }
  const driveTimePolygon = normalizeDriveTimeGeometry(
    value.driveTimePolygon ?? value.geoJson,
  );
  if (!driveTimePolygon) {
    return { ok: false, error: "A valid GeoJSON drive-time Polygon or MultiPolygon is required." };
  }
  if (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 100)) {
    return { ok: false, error: "query must be a string of at most 100 characters." };
  }
  if (value.limit !== undefined && (typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_TRAIL_SEARCH_RESULTS)) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_TRAIL_SEARCH_RESULTS}.` };
  }
  const query = typeof value.query === "string" ? value.query.trim() : "";
  return {
    ok: true,
    request: {
      regionId: value.regionId,
      driveTimePolygon,
      ...(query ? { query } : {}),
      limit: typeof value.limit === "number" ? value.limit : MAX_TRAIL_SEARCH_RESULTS,
    },
  };
}

const POINT_ON_SEGMENT_EPSILON = 1e-12;
const TARGET_EDGES_PER_LATITUDE_BIN = 64;
const MAX_LATITUDE_BINS = 4_096;
const MAX_EDGE_BIN_COPIES = 64;

function pointOnSegment(point: Position, start: Position, end: Position) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > POINT_ON_SEGMENT_EPSILON) return false;
  return point[0] >= Math.min(start[0], end[0]) - POINT_ON_SEGMENT_EPSILON &&
    point[0] <= Math.max(start[0], end[0]) + POINT_ON_SEGMENT_EPSILON &&
    point[1] >= Math.min(start[1], end[1]) - POINT_ON_SEGMENT_EPSILON &&
    point[1] <= Math.max(start[1], end[1]) + POINT_ON_SEGMENT_EPSILON;
}

function ringLocation(point: Position, ring: Position[]): "inside" | "outside" | "boundary" {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const start = ring[previous];
    const end = ring[index];
    if (pointOnSegment(point, start, end)) return "boundary";
    const crosses = (end[1] > point[1]) !== (start[1] > point[1]) &&
      point[0] < ((start[0] - end[0]) * (point[1] - end[1])) /
        (start[1] - end[1]) + end[0];
    if (crosses) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

function pointInPolygon(point: Position, coordinates: Position[][]) {
  const outer = ringLocation(point, coordinates[0]);
  if (outer === "outside") return false;
  if (outer === "boundary") return true;
  for (const hole of coordinates.slice(1)) {
    const location = ringLocation(point, hole);
    if (location === "boundary") return true;
    if (location === "inside") return false;
  }
  return true;
}

export function pointInDriveTimeGeometry(point: Position, geometry: DriveTimeGeometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

function prepareRing(ring: Position[]): PreparedRing {
  let minimumLongitude = Infinity;
  let minimumLatitude = Infinity;
  let maximumLongitude = -Infinity;
  let maximumLatitude = -Infinity;
  for (const [longitude, latitude] of ring) {
    minimumLongitude = Math.min(minimumLongitude, longitude);
    minimumLatitude = Math.min(minimumLatitude, latitude);
    maximumLongitude = Math.max(maximumLongitude, longitude);
    maximumLatitude = Math.max(maximumLatitude, latitude);
  }

  const edges: PreparedRingEdge[] = [];
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const start = ring[previous];
    const end = ring[index];
    edges.push({
      start,
      end,
      minimumLongitude: Math.min(start[0], end[0]),
      minimumLatitude: Math.min(start[1], end[1]),
      maximumLongitude: Math.max(start[0], end[0]),
      maximumLatitude: Math.max(start[1], end[1]),
    });
  }

  const binCount = Math.min(
    MAX_LATITUDE_BINS,
    Math.max(1, Math.ceil(edges.length / TARGET_EDGES_PER_LATITUDE_BIN)),
  );
  const latitudeBins = Array.from({ length: binCount }, (): number[] => []);
  const expandedMinimumLatitude = minimumLatitude - POINT_ON_SEGMENT_EPSILON;
  const expandedMaximumLatitude = maximumLatitude + POINT_ON_SEGMENT_EPSILON;
  const latitudeSpan = expandedMaximumLatitude - expandedMinimumLatitude;
  const latitudeBinIndex = (latitude: number) => Math.max(0, Math.min(
    binCount - 1,
    Math.floor(((latitude - expandedMinimumLatitude) / latitudeSpan) * binCount),
  ));
  const spanningEdgeIndexes: number[] = [];

  edges.forEach((edge, edgeIndex) => {
    const firstBin = latitudeBinIndex(edge.minimumLatitude - POINT_ON_SEGMENT_EPSILON);
    const lastBin = latitudeBinIndex(edge.maximumLatitude + POINT_ON_SEGMENT_EPSILON);
    if (lastBin - firstBin + 1 > MAX_EDGE_BIN_COPIES) {
      spanningEdgeIndexes.push(edgeIndex);
      return;
    }
    for (let binIndex = firstBin; binIndex <= lastBin; binIndex += 1) {
      latitudeBins[binIndex].push(edgeIndex);
    }
  });

  return {
    edges,
    latitudeBins,
    spanningEdgeIndexes,
    minimumLongitude: minimumLongitude - POINT_ON_SEGMENT_EPSILON,
    minimumLatitude: expandedMinimumLatitude,
    maximumLongitude: maximumLongitude + POINT_ON_SEGMENT_EPSILON,
    maximumLatitude: expandedMaximumLatitude,
  };
}

export function prepareDriveTimeGeometry(
  geometry: DriveTimeGeometry,
): PreparedDriveTimeGeometry {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return {
    polygons: polygons.map(([outer, ...holes]) => ({
      outer: prepareRing(outer),
      holes: holes.map(prepareRing),
    })),
  };
}

function preparedLatitudeBinIndex(ring: PreparedRing, latitude: number) {
  const span = ring.maximumLatitude - ring.minimumLatitude;
  return Math.max(0, Math.min(
    ring.latitudeBins.length - 1,
    Math.floor(((latitude - ring.minimumLatitude) / span) * ring.latitudeBins.length),
  ));
}

function preparedRingLocation(
  point: Position,
  ring: PreparedRing,
  stats?: PreparedGeometryStats,
): "inside" | "outside" | "boundary" {
  if (point[0] < ring.minimumLongitude || point[0] > ring.maximumLongitude ||
      point[1] < ring.minimumLatitude || point[1] > ring.maximumLatitude) {
    if (stats) stats.boundsRejected += 1;
    return "outside";
  }

  let inside = false;
  const bin = ring.latitudeBins[preparedLatitudeBinIndex(ring, point[1])];
  const candidateIndexes = ring.spanningEdgeIndexes.length === 0
    ? bin
    : [...ring.spanningEdgeIndexes, ...bin];
  if (stats) stats.candidateEdges += candidateIndexes.length;

  for (const edgeIndex of candidateIndexes) {
    const edge = ring.edges[edgeIndex];
    if (point[1] < edge.minimumLatitude - POINT_ON_SEGMENT_EPSILON ||
        point[1] > edge.maximumLatitude + POINT_ON_SEGMENT_EPSILON ||
        point[0] > edge.maximumLongitude + POINT_ON_SEGMENT_EPSILON) {
      continue;
    }
    if (stats) stats.edgeChecks += 1;
    if (pointOnSegment(point, edge.start, edge.end)) return "boundary";
    const crosses = (edge.end[1] > point[1]) !== (edge.start[1] > point[1]) &&
      point[0] < ((edge.start[0] - edge.end[0]) * (point[1] - edge.end[1])) /
        (edge.start[1] - edge.end[1]) + edge.end[0];
    if (crosses) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

export function pointInPreparedDriveTimeGeometry(
  point: Position,
  geometry: PreparedDriveTimeGeometry,
  stats?: PreparedGeometryStats,
) {
  return geometry.polygons.some((polygon) => {
    const outer = preparedRingLocation(point, polygon.outer, stats);
    if (outer === "outside") return false;
    if (outer === "boundary") return true;
    for (const hole of polygon.holes) {
      const location = preparedRingLocation(point, hole, stats);
      if (location === "boundary") return true;
      if (location === "inside") return false;
    }
    return true;
  });
}

function searchableText(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US");
}

function userFacing(summary: TrailSearchSummary | undefined) {
  return Boolean(summary) && !summary!.suppressed && summary!.routeClass === "hiking" &&
    summary!.hiking !== "blocked" && summary!.access !== "private" && summary!.status !== "closed";
}

function statusNotices(summary: TrailSearchSummary) {
  const notices = [...(summary.notices ?? [])];
  if (summary.hiking === "unknown" && !notices.some((notice) => /permission is unknown/i.test(notice))) {
    notices.push("Hiking permission is unknown; verify current rules before visiting.");
  }
  if (summary.status === "seasonal") notices.push("This trail has seasonal availability.");
  if (summary.status === "unknown") notices.push("Current trail status is unknown.");
  if (summary.access === "unknown") notices.push("Public access is not explicitly confirmed.");
  return [...new Set(notices)];
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const ACCESS_EVIDENCE_RANK = Object.freeze({ official: 0, mapped: 1, derived: 2 });

function accessPointMetadata(feature: AccessPointFeature): TrailAccessPointMetadata {
  return {
    id: feature.properties.id,
    ...(feature.properties.name ? { name: feature.properties.name } : {}),
    type: feature.properties.type,
    confidence: feature.properties.confidence,
    sourceRefs: feature.properties.sourceRefs,
    longitude: feature.geometry.coordinates[0],
    latitude: feature.geometry.coordinates[1],
  };
}

function compareAccessPoints(left: TrailAccessPointMetadata, right: TrailAccessPointMetadata) {
  return ACCESS_EVIDENCE_RANK[left.confidence] - ACCESS_EVIDENCE_RANK[right.confidence] ||
    left.id.localeCompare(right.id) ||
    left.longitude - right.longitude || left.latitude - right.latitude;
}

function earthCenteredPoint({ longitude, latitude }: TrailAccessPointMetadata) {
  const longitudeRadians = longitude * Math.PI / 180;
  const latitudeRadians = latitude * Math.PI / 180;
  const latitudeRadius = EARTH_RADIUS_METERS * Math.cos(latitudeRadians);
  return [
    latitudeRadius * Math.cos(longitudeRadians),
    latitudeRadius * Math.sin(longitudeRadians),
    EARTH_RADIUS_METERS * Math.sin(latitudeRadians),
  ] as const;
}

function spatialCell(coordinates: readonly number[]) {
  return coordinates.map((coordinate) =>
    Math.floor(coordinate / ACCESS_POINT_EQUIVALENCE_METERS));
}

function cellKey(cell: readonly number[]) {
  return cell.join(":");
}

/**
 * Product-only geographic summarization. Canonical access features and their
 * connected graph nodes are never mutated or removed.
 */
export function geographicallyDistinctAccessPoints(
  candidates: TrailAccessPointMetadata[],
) {
  const representatives: Array<{
    point: TrailAccessPointMetadata;
    centered: readonly [number, number, number];
  }> = [];
  const byCell = new Map<string, number[]>();
  const maximumChordSquared = ACCESS_POINT_EQUIVALENCE_METERS ** 2;

  for (const point of [...candidates].sort(compareAccessPoints)) {
    const centered = earthCenteredPoint(point);
    const cell = spatialCell(centered);
    let equivalent = false;
    for (let x = -1; x <= 1 && !equivalent; x += 1) {
      for (let y = -1; y <= 1 && !equivalent; y += 1) {
        for (let z = -1; z <= 1 && !equivalent; z += 1) {
          const indexes = byCell.get(cellKey([cell[0] + x, cell[1] + y, cell[2] + z])) ?? [];
          equivalent = indexes.some((index) => {
            const candidate = representatives[index].centered;
            return (centered[0] - candidate[0]) ** 2 +
              (centered[1] - candidate[1]) ** 2 +
              (centered[2] - candidate[2]) ** 2 <= maximumChordSquared;
          });
        }
      }
    }
    if (equivalent) continue;

    const index = representatives.length;
    representatives.push({ point, centered });
    const key = cellKey(cell);
    const indexes = byCell.get(key) ?? [];
    indexes.push(index);
    byCell.set(key, indexes);
  }
  return representatives.map(({ point }) => point);
}

export function trailAccessPointDetails(
  catalog: RegionalTrailCatalog,
  trail: NamedTrailRecord,
) {
  const accessPoints = new Map(catalog.accessPoints.map((feature) =>
    [feature.properties.id, feature]));
  return trail.accessPointIds.flatMap((id): TrailAccessPointDetail[] => {
    const feature = accessPoints.get(id);
    if (!feature) return [];
    return [{
      ...accessPointMetadata(feature),
      connectedNodeIds: [...feature.properties.connectedNodeIds],
    }];
  }).sort(compareAccessPoints);
}

export function findUserFacingTrail(catalog: RegionalTrailCatalog, trailId: string) {
  const trail = catalog.namedTrails.find(({ id }) => id === trailId);
  if (!trail || !userFacing(catalog.summaries[trail.id])) return null;
  return trail;
}

export function searchTrails(catalog: RegionalTrailCatalog, request: TrailSearchRequest) {
  if (request.regionId !== catalog.manifest.region.id) {
    throw new RangeError(`Catalog does not contain region ${request.regionId}`);
  }
  const accessPoints = new Map(catalog.accessPoints.map((feature) =>
    [feature.properties.id, feature]));
  const preparedDriveTimeGeometry = prepareDriveTimeGeometry(request.driveTimePolygon);
  const reachableAccessPointIds = new Set(catalog.accessPoints.flatMap((feature) =>
    pointInPreparedDriveTimeGeometry(feature.geometry.coordinates, preparedDriveTimeGeometry)
      ? [feature.properties.id]
      : []));
  const query = request.query ? searchableText(request.query) : undefined;
  const results = [];

  for (const trail of catalog.namedTrails) {
    const summary = catalog.summaries[trail.id];
    if (!summary || !userFacing(summary)) continue;
    if (query && !searchableText(`${trail.name} ${trail.manager ?? ""}`).includes(query)) continue;
    const reachableAccessPoints = trail.accessPointIds.flatMap((id) => {
      const feature = accessPoints.get(id);
      if (!feature || !reachableAccessPointIds.has(id)) {
        return [];
      }
      return [accessPointMetadata(feature)];
    });
    if (reachableAccessPoints.length === 0) continue;
    const distinctAccessPoints = geographicallyDistinctAccessPoints(reachableAccessPoints);
    results.push({
      id: trail.id,
      name: trail.name,
      ...(trail.manager ? { manager: trail.manager } : {}),
      bounds: trail.bounds,
      ...(trail.lengthMeters !== undefined ? { lengthMeters: trail.lengthMeters } : {}),
      dataConfidence: trail.dataConfidence,
      hiking: summary.hiking,
      access: summary.access,
      status: summary.status,
      ...(summary.surfaces ? { surfaces: summary.surfaces } : {}),
      ...(summary.elevation ? { elevation: summary.elevation } : {}),
      notices: statusNotices(summary),
      accessPointCount: distinctAccessPoints.length,
      accessPoints: distinctAccessPoints.slice(0, MAX_REPRESENTATIVE_ACCESS_POINTS),
      sourceRefs: trail.sourceRefs,
      geometryUrl: `/api/trails/${catalog.manifest.region.id}/${trail.id}/geometry`,
    });
  }

  results.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    artifactVersion: catalog.manifest.buildId ?? catalog.manifest.generatedAt,
    region: catalog.manifest.region,
    count: results.length,
    trails: results.slice(0, request.limit),
  };
}

export function segmentShardKey(segmentId: string, prefixLength = 1) {
  if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 8) {
    throw new TypeError(`Invalid segment partition prefix length: ${prefixLength}`);
  }
  const match = /^segment_([0-9a-f]+)$/.exec(segmentId);
  if (!match || match[1].length < prefixLength) {
    throw new TypeError(`Invalid segment id: ${segmentId}`);
  }
  return match[1].slice(0, prefixLength);
}

export async function loadTrailSegments(
  catalog: RegionalTrailCatalog,
  trailId: string,
  loadShard: (shard: string, selectedIds: ReadonlySet<string>) => Promise<TrailSegment[]>,
) {
  const trail = findUserFacingTrail(catalog, trailId);
  if (!trail) return null;
  const idsByShard = new Map<string, Set<string>>();
  for (const segmentId of trail.segmentIds) {
    const shard = segmentShardKey(segmentId, catalog.partitionPrefixLength);
    const selected = idsByShard.get(shard) ?? new Set<string>();
    selected.add(segmentId);
    idsByShard.set(shard, selected);
  }
  const loaded = await Promise.all([...idsByShard.entries()].map(async ([shard, ids]) => {
    if (!catalog.shardPaths[shard]) throw new Error(`Missing catalog shard ${shard}`);
    return loadShard(shard, ids);
  }));
  const segmentsById = new Map(loaded.flat().map((segment) => [segment.id, segment]));
  const missing = trail.segmentIds.filter((segmentId) => !segmentsById.has(segmentId));
  if (missing.length > 0) throw new Error(`Geometry is missing ${missing.length} trail segments.`);
  return trail.segmentIds.map((segmentId) => segmentsById.get(segmentId)!);
}

export function trailGeometryFeatureCollection(
  regionId: string,
  trail: NamedTrailRecord,
  segments: TrailSegment[],
  accessPoints: TrailAccessPointDetail[] = [],
) {
  const accessPointCount = geographicallyDistinctAccessPoints(accessPoints).length;
  return {
    type: "FeatureCollection" as const,
    properties: {
      schemaVersion: 1,
      regionId,
      trailId: trail.id,
      accessPointCount,
      accessPoints,
    },
    features: segments.map(({ geometry, displayGeometry, ...properties }) => {
      const safeProperties = { ...properties };
      delete safeProperties.maxGradePct;
      return {
        type: "Feature" as const,
        id: safeProperties.id,
        geometry: displayGeometry ?? geometry,
        properties: safeProperties,
      };
    }),
  };
}
