// ArcGIS long-range service areas can legitimately contain tens of thousands
// of vertices. Keep the transport ceiling aligned with the stricter 50,000
// vertex geometry cap below so valid contours are not rejected based only on
// JSON encoding overhead.
export const MAX_TRAIL_SEARCH_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_TRAIL_SEARCH_RESULTS = 500;

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
    generatedAt: string;
    region: {
      id: string;
      label: string;
      bounds: [number, number, number, number];
    };
  };
  namedTrails: NamedTrailRecord[];
  accessPoints: AccessPointFeature[];
  summaries: Record<string, TrailSearchSummary>;
  shardPaths: Record<string, string>;
};

type Position = [number, number];
type PolygonGeometry = { type: "Polygon"; coordinates: Position[][] };
type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Position[][][] };
export type DriveTimeGeometry = PolygonGeometry | MultiPolygonGeometry;

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
  if (!polygons || vertexCount(polygons) > 50_000) return null;
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

function pointOnSegment(point: Position, start: Position, end: Position) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-12) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-12 &&
    point[0] <= Math.max(start[0], end[0]) + 1e-12 &&
    point[1] >= Math.min(start[1], end[1]) - 1e-12 &&
    point[1] <= Math.max(start[1], end[1]) + 1e-12;
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
  const query = request.query ? searchableText(request.query) : undefined;
  const results = [];

  for (const trail of catalog.namedTrails) {
    const summary = catalog.summaries[trail.id];
    if (!summary || !userFacing(summary)) continue;
    if (query && !searchableText(`${trail.name} ${trail.manager ?? ""}`).includes(query)) continue;
    const reachableAccessPoints = trail.accessPointIds.flatMap((id) => {
      const feature = accessPoints.get(id);
      if (!feature || !pointInDriveTimeGeometry(feature.geometry.coordinates, request.driveTimePolygon)) {
        return [];
      }
      return [{
        id: feature.properties.id,
        ...(feature.properties.name ? { name: feature.properties.name } : {}),
        type: feature.properties.type,
        confidence: feature.properties.confidence,
        sourceRefs: feature.properties.sourceRefs,
        longitude: feature.geometry.coordinates[0],
        latitude: feature.geometry.coordinates[1],
      }];
    });
    if (reachableAccessPoints.length === 0) continue;
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
      accessPoints: reachableAccessPoints,
      sourceRefs: trail.sourceRefs,
      geometryUrl: `/api/trails/${catalog.manifest.region.id}/${trail.id}/geometry`,
    });
  }

  results.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    artifactVersion: catalog.manifest.generatedAt,
    region: catalog.manifest.region,
    count: results.length,
    trails: results.slice(0, request.limit),
  };
}

export function segmentShardKey(segmentId: string) {
  const match = /^segment_([0-9a-f])[0-9a-f]+$/.exec(segmentId);
  if (!match) throw new TypeError(`Invalid segment id: ${segmentId}`);
  return match[1];
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
    const shard = segmentShardKey(segmentId);
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
) {
  return {
    type: "FeatureCollection" as const,
    properties: { schemaVersion: 1, regionId, trailId: trail.id },
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
