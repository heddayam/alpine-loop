import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { edgeIsInsideBbox, lineIsInsideArea } from "./geometry";
import { accessPointIsEligible, edgeIsTraversable } from "./policy";
import type {
  AccessState,
  AccessPointCandidate,
  AccessPointCandidateQuery,
  GraphAccessPoint,
  GraphEdge,
  EdgeClass,
  GraphNode,
  GraphQuery,
  GraphRepository,
  InducedGraph,
  ReachableGraphQuery,
  ReachableGraphResult,
} from "./types";

type SqliteRow = Record<string, SQLInputValue>;

function requiredString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Graph database corruption: invalid ${column}`);
  return value;
}

function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Graph database corruption: invalid ${column}`);
  return value;
}

function nullableNumber(row: SqliteRow, column: string): number | null {
  const value = row[column];
  return value === null ? null : requiredNumber(row, column);
}

function numberOrZero(row: SqliteRow, column: string): number {
  return nullableNumber(row, column) ?? 0;
}

function jsonArray<T>(value: SQLInputValue | undefined, label: string): T[] {
  if (typeof value !== "string") throw new Error(`Graph database corruption: invalid ${label}`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Graph database corruption: invalid ${label} JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`Graph database corruption: invalid ${label}`);
  return parsed as T[];
}

function parseCoordinates(value: SQLInputValue | undefined): Array<readonly [number, number]> {
  const coordinates = jsonArray<unknown>(value, "geometry");
  if (
    coordinates.length < 2 ||
    !coordinates.every(
      (coordinate) =>
        Array.isArray(coordinate) &&
        coordinate.length >= 2 &&
        typeof coordinate[0] === "number" &&
        Number.isFinite(coordinate[0]) &&
        typeof coordinate[1] === "number" &&
        Number.isFinite(coordinate[1]),
    )
  ) {
    throw new Error("Graph database corruption: invalid edge geometry");
  }
  return coordinates.map((coordinate) => {
    const pair = coordinate as number[];
    return [pair[0], pair[1]] as const;
  });
}

function parseAccessState(value: string): AccessState {
  if (["public", "unknown", "private", "closed", "prohibited"].includes(value)) return value as AccessState;
  throw new Error(`Invalid access state: ${value}`);
}

function parseEdgeClass(value: SQLInputValue | undefined): EdgeClass {
  if (["trail", "service-road", "street", "sidewalk"].includes(String(value))) return value as EdgeClass;
  throw new Error(`Invalid edge class: ${String(value)}`);
}

function parsePortalRoadClass(value: SQLInputValue | undefined): "street" | "service-road" {
  if (value === "street" || value === "service-road") return value;
  throw new Error("Graph database corruption: invalid portal road class");
}

function cycleReachability(row: SqliteRow): boolean {
  const value = requiredNumber(row, "can_reach_cycle");
  if (value !== 0 && value !== 1) throw new Error("Graph database corruption: invalid cycle reachability");
  return value === 1;
}

function parseNode(row: SqliteRow): GraphNode {
  return {
    id: requiredString(row, "id"),
    lon: requiredNumber(row, "lon"),
    lat: requiredNumber(row, "lat"),
    elevationMeters: nullableNumber(row, "elevation_m"),
    flags: jsonArray<string>(row.flags, "node flags"),
  };
}

function parseEdge(row: SqliteRow): GraphEdge {
  const flags = jsonArray<string>(row.flags, "edge flags");
  const encodedTrailName = flags.find((flag) => flag.startsWith("trail-name:"))?.slice("trail-name:".length);
  const encodedElevationProfile = row.elevation_profile === null ? [] : jsonArray<unknown>(row.elevation_profile, "edge elevation_profile");
  if (encodedElevationProfile.some((sample) => !Array.isArray(sample) || sample.length !== 2
    || sample.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    throw new Error("Graph database corruption: invalid edge elevation_profile");
  }
  const elevationProfile = (encodedElevationProfile as Array<[number, number]>).map(
    ([distanceMeters, elevationMeters]) => ({ distanceMeters, elevationMeters }),
  );
  return {
    id: requiredString(row, "id"),
    edgeKey: requiredNumber(row, "edge_key"),
    physicalEdgeKey: requiredNumber(row, "physical_edge_key"),
    fromNodeId: requiredString(row, "from_node"),
    toNodeId: requiredString(row, "to_node"),
    coordinates: parseCoordinates(row.geometry),
    lengthMeters: requiredNumber(row, "length_m"),
    gainMeters: numberOrZero(row, "gain_m"),
    lossMeters: numberOrZero(row, "loss_m"),
    maximumElevationMeters: nullableNumber(row, "max_elevation_m"),
    maximumSustainedGradePct: nullableNumber(row, "max_sustained_grade_pct"),
    ...(elevationProfile.length > 0 ? { elevationProfile } : {}),
    accessState: parseAccessState(requiredString(row, "access_state")),
    edgeClass: parseEdgeClass(row.edge_class),
    trailName: encodedTrailName || null,
    sourceIds: jsonArray<string>(row.source_refs, "edge source_refs"),
    flags,
  };
}

function parseAccessPoint(row: SqliteRow): GraphAccessPoint {
  const kind = requiredString(row, "kind");
  const confidence = requiredString(row, "confidence");
  if (!["trailhead", "parking", "transit"].includes(kind)) throw new Error(`Invalid access point kind: ${kind}`);
  if (!["high", "medium", "low"].includes(confidence)) throw new Error(`Invalid confidence: ${confidence}`);
  return {
    id: requiredString(row, "id"),
    nodeId: requiredString(row, "node_id"),
    name: requiredString(row, "name"),
    kind: kind as GraphAccessPoint["kind"],
    accessState: parseAccessState(requiredString(row, "access_state")),
    confidence: confidence as GraphAccessPoint["confidence"],
    parkingEvidence: typeof row.parking_evidence === "string" ? row.parking_evidence : null,
    sourceIds: jsonArray<string>(row.source_refs, "access point source_refs"),
    nearbyBuildingCount: requiredNumber(row, "nearby_building_count"),
    reachableTrailKm: requiredNumber(row, "reachable_trail_km"),
    trailComponentId: requiredString(row, "trail_component_id"),
    portalRoadClass: parsePortalRoadClass(row.portal_road_class),
    parkingDistanceM: nullableNumber(row, "parking_distance_m"),
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Graph query was cancelled", "AbortError");
}

type DistanceEntry = { nodeId: string; distance: number };

class DistanceQueue {
  readonly #items: DistanceEntry[] = [];

  push(entry: DistanceEntry): void {
    this.#items.push(entry);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.#before(this.#items[index], this.#items[parent])) break;
      [this.#items[index], this.#items[parent]] = [this.#items[parent], this.#items[index]];
      index = parent;
    }
  }

  pop(): DistanceEntry | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (!first || !last || this.#items.length === 0) return first;
    this.#items[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < this.#items.length && this.#before(this.#items[left], this.#items[next])) next = left;
      if (right < this.#items.length && this.#before(this.#items[right], this.#items[next])) next = right;
      if (next === index) break;
      [this.#items[index], this.#items[next]] = [this.#items[next], this.#items[index]];
      index = next;
    }
    return first;
  }

  get size(): number {
    return this.#items.length;
  }

  #before(left: DistanceEntry, right: DistanceEntry): boolean {
    return left.distance < right.distance ||
      (left.distance === right.distance && left.nodeId.localeCompare(right.nodeId) < 0);
  }
}

export class SQLiteGraphRepository implements GraphRepository {
  readonly packId: string;
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string, packId: string) {
    if (!packId) throw new Error("A pack ID is required for a SQLite graph repository");
    this.packId = packId;
    this.#database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const metadata = this.#database.prepare("SELECT key, value FROM metadata WHERE key IN ('schemaVersion', 'packId')").all();
      if (metadata.find(({ key }) => key === "schemaVersion")?.value !== "6") throw new Error("expected schema version 6");
      if (metadata.find(({ key }) => key === "packId")?.value !== packId) throw new Error("pack identity mismatch");
      // Preparing these queries validates the required layout without scanning graph data.
      this.#database.prepare("SELECT id, node_key, lon, lat, elevation_m, flags FROM nodes LIMIT 0");
      this.#database.prepare(`SELECT id, edge_key, physical_edge_key, from_node, to_node, geometry, length_m,
        gain_m, loss_m, max_elevation_m, max_sustained_grade_pct, elevation_profile, access_state, edge_class,
        source_refs, flags FROM edges LIMIT 0`);
      this.#database.prepare(`SELECT id, node_id, name, kind, access_state, confidence, parking_evidence, source_refs,
        known_connectivity, inclusive_connectivity, known_out_degree, inclusive_out_degree, nearby_building_count,
        reachable_trail_km, trail_component_id, portal_road_class, parking_distance_m FROM access_points LIMIT 0`);
      this.#database.prepare("SELECT row_id, min_lon, max_lon, min_lat, max_lat FROM node_spatial LIMIT 0");
      this.#database.prepare("SELECT row_id, min_lon, max_lon, min_lat, max_lat FROM edge_spatial LIMIT 0");
      this.#database.prepare("SELECT profile, access_point_id, can_reach_cycle FROM access_topology LIMIT 0");
    } catch (error) {
      this.#database.close();
      throw new Error(`Graph database corruption: ${error instanceof Error ? error.message : String(error)}. Rebuild this pack.`);
    }
  }

  async getInducedGraph(query: GraphQuery): Promise<InducedGraph> {
    assertNotAborted(query.signal);
    const [west, south, east, north] = query.bbox;
    const nodeRows = this.#database.prepare(`SELECT nodes.* FROM nodes
      JOIN node_spatial ON node_spatial.row_id = nodes.rowid
      WHERE node_spatial.max_lon >= ? AND node_spatial.min_lon <= ?
        AND node_spatial.max_lat >= ? AND node_spatial.min_lat <= ?
      ORDER BY nodes.id`).all(west, east, south, north) as SqliteRow[];
    const nodes = new Map<string, GraphNode>();
    for (const row of nodeRows) {
      assertNotAborted(query.signal);
      const node = parseNode(row);
      nodes.set(node.id, node);
    }

    const edgeRows = this.#database.prepare(`SELECT edges.* FROM edges
      JOIN edge_spatial ON edge_spatial.row_id = edges.rowid
      WHERE edge_spatial.max_lon >= ? AND edge_spatial.min_lon <= ?
        AND edge_spatial.max_lat >= ? AND edge_spatial.min_lat <= ?
      ORDER BY edges.id`).all(west, east, south, north) as SqliteRow[];
    const edges: GraphEdge[] = [];
    for (const row of edgeRows) {
      assertNotAborted(query.signal);
      const edge = parseEdge(row);
      if (
        nodes.has(edge.fromNodeId) &&
        nodes.has(edge.toNodeId) &&
        edgeIsInsideBbox(edge, query.bbox) &&
        edgeIsTraversable(edge, query.includeUncertainAccess)
      ) {
        edges.push(edge);
      }
    }

    const accessRows = this.#database.prepare("SELECT * FROM access_points ORDER BY id").all() as SqliteRow[];
    const accessPoints = accessRows
      .map((row) => parseAccessPoint(row))
      .filter(
        (accessPoint) =>
          nodes.has(accessPoint.nodeId) && accessPointIsEligible(accessPoint, query.includeUncertainAccess),
      );
    return { nodes, edges, accessPoints };
  }

  async getAccessPointCandidates(query: AccessPointCandidateQuery): Promise<AccessPointCandidate[]> {
    assertNotAborted(query.signal);
    const [west, south, east, north] = query.bbox;
    const rows = this.#database.prepare(
      `SELECT access_points.*, nodes.lon AS candidate_lon, nodes.lat AS candidate_lat, access_topology.can_reach_cycle
       FROM access_points
       JOIN nodes ON nodes.id = access_points.node_id
       JOIN node_spatial ON node_spatial.row_id = nodes.rowid
       LEFT JOIN access_topology ON access_topology.access_point_id = access_points.id AND access_topology.profile = 'inclusive'
       WHERE node_spatial.min_lon <= ? AND node_spatial.max_lon >= ?
         AND node_spatial.min_lat <= ? AND node_spatial.max_lat >= ?
       ORDER BY access_points.id`,
    ).all(east, west, north, south) as SqliteRow[];
    return rows.flatMap((row) => {
      assertNotAborted(query.signal);
      const point = parseAccessPoint(row);
      if (!accessPointIsEligible(point, query.includeUncertainAccess)) return [];
      return [{
        ...point,
        lon: requiredNumber(row, "candidate_lon"),
        lat: requiredNumber(row, "candidate_lat"),
        knownConnectivity: requiredNumber(row, "known_connectivity"),
        inclusiveConnectivity: requiredNumber(row, "inclusive_connectivity"),
        knownOutDegree: requiredNumber(row, "known_out_degree"),
        inclusiveOutDegree: requiredNumber(row, "inclusive_out_degree"),
        canReachCycle: cycleReachability(row),
      }];
    });
  }

  async getReachableGraph(query: ReachableGraphQuery): Promise<ReachableGraphResult> {
    assertNotAborted(query.signal);
    const nodeStatement = this.#database.prepare("SELECT * FROM nodes WHERE id = ?");
    const edgeStatement = this.#database.prepare("SELECT * FROM edges WHERE from_node = ? ORDER BY id");
    const startRow = nodeStatement.get(query.startNodeId) as SqliteRow | undefined;
    if (!startRow) return { graph: { nodes: new Map(), edges: [], accessPoints: [] }, truncated: false };
    const start = parseNode(startRow);
    const nodes = new Map<string, GraphNode>([[start.id, start]]);
    const edges: GraphEdge[] = [];
    const edgeIds = new Set<string>();
    const distances = new Map<string, number>([[start.id, 0]]);
    const pending = new DistanceQueue();
    pending.push({ nodeId: start.id, distance: 0 });
    let truncated = false;
    while (pending.size > 0) {
      assertNotAborted(query.signal);
      const current = pending.pop()!;
      if (current.distance !== distances.get(current.nodeId)) continue;
      const rows = edgeStatement.all(current.nodeId) as SqliteRow[];
      for (const row of rows) {
        assertNotAborted(query.signal);
        const edge = parseEdge(row);
        if (
          !edgeIsTraversable(edge, query.includeUncertainAccess) ||
          !lineIsInsideArea(edge.coordinates, query.coverage)
        ) continue;
        const nextDistance = current.distance + edge.lengthMeters;
        if (nextDistance > query.maximumDistanceMeters) continue;
        if (!edgeIds.has(edge.id)) {
          if (edges.length >= query.maximumDirectedEdges) {
            truncated = true;
            break;
          }
          edgeIds.add(edge.id);
          edges.push(edge);
        }
        let to = nodes.get(edge.toNodeId);
        if (!to) {
          const toRow = nodeStatement.get(edge.toNodeId) as SqliteRow | undefined;
          if (!toRow) continue;
          to = parseNode(toRow);
          nodes.set(to.id, to);
        }
        const previous = distances.get(edge.toNodeId);
        if (previous === undefined || nextDistance < previous) {
          distances.set(edge.toNodeId, nextDistance);
          pending.push({ nodeId: edge.toNodeId, distance: nextDistance });
        }
      }
      if (truncated) break;
    }
    const accessRows = this.#database.prepare("SELECT * FROM access_points ORDER BY id").all() as SqliteRow[];
    const accessPoints = accessRows.map((row) => parseAccessPoint(row)).filter(
      (point) => nodes.has(point.nodeId) && accessPointIsEligible(point, query.includeUncertainAccess),
    );
    return { graph: { nodes, edges, accessPoints }, truncated };
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
