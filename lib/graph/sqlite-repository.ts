import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { edgeIsInsideBbox, lineIsInsideArea } from "./geometry";
import { accessPointIsEligible, edgeIsTraversable } from "./policy";
import type {
  AccessState,
  AccessPointCandidate,
  AccessPointCandidateQuery,
  GraphAccessPoint,
  GraphEdge,
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
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid SQLite ${column}`);
  return value;
}

function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid SQLite ${column}`);
  return value;
}

function nullableNumber(row: SqliteRow, column: string): number | null {
  const value = row[column];
  return value === null || value === undefined ? null : requiredNumber(row, column);
}

function numberOrZero(row: SqliteRow, column: string): number {
  return nullableNumber(row, column) ?? 0;
}

function jsonArray<T>(value: SQLInputValue | undefined, label: string): T[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${label}`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`Invalid SQLite ${label}`);
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
    throw new Error("Invalid SQLite edge geometry");
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

function parseNode(row: SqliteRow): GraphNode {
  return {
    id: requiredString(row, "id"),
    ...(typeof row.physical_edge_key === "number"
      ? { physicalEdgeKey: requiredNumber(row, "physical_edge_key") }
      : {}),
    lon: requiredNumber(row, "lon"),
    lat: requiredNumber(row, "lat"),
    elevationMeters: nullableNumber(row, "elevation_m"),
    flags: jsonArray<string>(row.flags, "node flags"),
  };
}

function parseEdge(row: SqliteRow): GraphEdge {
  const flags = jsonArray<string>(row.flags, "edge flags");
  const encodedTrailName = flags.find((flag) => flag.startsWith("trail-name:"))?.slice("trail-name:".length);
  return {
    id: requiredString(row, "id"),
    fromNodeId: requiredString(row, "from_node"),
    toNodeId: requiredString(row, "to_node"),
    coordinates: parseCoordinates(row.geometry),
    lengthMeters: requiredNumber(row, "length_m"),
    gainMeters: numberOrZero(row, "gain_m"),
    lossMeters: numberOrZero(row, "loss_m"),
    maximumElevationMeters: nullableNumber(row, "max_elevation_m"),
    maximumSustainedGradePct: nullableNumber(row, "max_sustained_grade_pct"),
    accessState: parseAccessState(requiredString(row, "access_state")),
    trailName:
      typeof row.trail_name === "string" && row.trail_name.length > 0
        ? row.trail_name
        : encodedTrailName || null,
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
  }

  #hasTable(name: string): boolean {
    return Boolean(
      this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
  }

  #hasColumn(table: string, column: string): boolean {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[];
    return rows.some((row) => row.name === column);
  }

  async getInducedGraph(query: GraphQuery): Promise<InducedGraph> {
    assertNotAborted(query.signal);
    const [west, south, east, north] = query.bbox;
    const nodeRows = (this.#hasTable("node_spatial")
      ? this.#database
          .prepare(
            `SELECT nodes.* FROM nodes
             JOIN node_spatial ON node_spatial.row_id = nodes.rowid
             WHERE node_spatial.max_lon >= ? AND node_spatial.min_lon <= ?
               AND node_spatial.max_lat >= ? AND node_spatial.min_lat <= ?
             ORDER BY nodes.id`,
          )
          .all(west, east, south, north)
      : this.#database
          .prepare("SELECT * FROM nodes WHERE lon >= ? AND lon <= ? AND lat >= ? AND lat <= ? ORDER BY id")
          .all(west, east, south, north)) as SqliteRow[];
    const nodes = new Map<string, GraphNode>();
    for (const row of nodeRows) {
      assertNotAborted(query.signal);
      const node = parseNode(row);
      nodes.set(node.id, node);
    }

    const edgeRows = (this.#hasTable("edge_spatial")
      ? this.#database
          .prepare(
            `SELECT edges.* FROM edges
             JOIN edge_spatial ON edge_spatial.row_id = edges.rowid
             WHERE edge_spatial.max_lon >= ? AND edge_spatial.min_lon <= ?
               AND edge_spatial.max_lat >= ? AND edge_spatial.min_lat <= ?
             ORDER BY edges.id`,
          )
          .all(west, east, south, north)
      : this.#database.prepare("SELECT * FROM edges ORDER BY id").all()) as SqliteRow[];
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
      .map(parseAccessPoint)
      .filter(
        (accessPoint) =>
          nodes.has(accessPoint.nodeId) && accessPointIsEligible(accessPoint, query.includeUncertainAccess),
      );
    return { nodes, edges, accessPoints };
  }

  async getAccessPoints(
    bbox: GraphQuery["bbox"],
    includeUncertainAccess: boolean,
  ): Promise<GraphAccessPoint[]> {
    const [west, south, east, north] = bbox;
    const rows = (this.#hasTable("node_spatial")
      ? this.#database
          .prepare(
            `SELECT access_points.* FROM access_points
             JOIN nodes ON nodes.id = access_points.node_id
             JOIN node_spatial ON node_spatial.row_id = nodes.rowid
             WHERE node_spatial.max_lon >= ? AND node_spatial.min_lon <= ?
               AND node_spatial.max_lat >= ? AND node_spatial.min_lat <= ?
             ORDER BY access_points.id`,
          )
          .all(west, east, south, north)
      : this.#database
          .prepare(
            `SELECT access_points.* FROM access_points
             JOIN nodes ON nodes.id = access_points.node_id
             WHERE nodes.lon >= ? AND nodes.lon <= ? AND nodes.lat >= ? AND nodes.lat <= ?
             ORDER BY access_points.id`,
          )
          .all(west, east, south, north)) as SqliteRow[];
    return rows.map(parseAccessPoint).filter((accessPoint) => accessPointIsEligible(accessPoint, includeUncertainAccess));
  }

  async getAccessPointCandidates(query: AccessPointCandidateQuery): Promise<AccessPointCandidate[]> {
    assertNotAborted(query.signal);
    const [west, south, east, north] = query.bbox;
    const hasRanking = this.#hasColumn("access_points", "known_connectivity");
    const rankingColumns = hasRanking
      ? "access_points.known_connectivity, access_points.inclusive_connectivity, access_points.known_out_degree, access_points.inclusive_out_degree"
      : "0 AS known_connectivity, 0 AS inclusive_connectivity, 0 AS known_out_degree, 0 AS inclusive_out_degree";
    const rows = this.#database.prepare(
      `SELECT access_points.*, nodes.lon AS candidate_lon, nodes.lat AS candidate_lat, ${rankingColumns}
       FROM access_points
       JOIN nodes ON nodes.id = access_points.node_id
       JOIN node_spatial ON node_spatial.row_id = nodes.rowid
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
    const accessPoints = accessRows.map(parseAccessPoint).filter(
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
