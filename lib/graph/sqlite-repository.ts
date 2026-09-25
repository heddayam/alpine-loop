import { DatabaseSync } from "node:sqlite";
import { coordinateIsInsideBbox, edgeIsInsideBbox, lineIsInsideArea } from "./geometry";
import { accessPointIsEligible, edgeIsTraversable } from "./policy";
import type {
  AccessPointCandidate,
  AccessPointCandidateQuery,
  GraphEdge,
  GraphNode,
  GraphQuery,
  GraphRepository,
  InducedGraph,
  ReachableGraphQuery,
  ReachableGraphResult,
} from "./types";

import { type SqliteRow, type MapTrailEdge, requiredString, jsonArray, parseCoordinates, parseAccessState, parseEdgeClass, requiredNumber, parseMinimumStem, parseNode, parseEdge,
  parseAccessPoint, assertNotAborted, DistanceQueue } from "./sqlite-records";

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

  /** Streams display-only edges; the consumer can stop before loading a whole graph. */
  async *iterateMapTrails(query: GraphQuery): AsyncGenerator<MapTrailEdge> {
    assertNotAborted(query.signal);
    const [west, south, east, north] = query.bbox;
    const rows = this.#database.prepare(`SELECT edges.id, edges.physical_edge_key, edges.geometry,
        edges.length_m, edges.access_state, edges.edge_class, edges.source_refs, edges.flags
      FROM edges
      JOIN edge_spatial ON edge_spatial.row_id = edges.rowid
      JOIN nodes AS from_node ON from_node.id = edges.from_node
      JOIN node_spatial AS from_spatial ON from_spatial.row_id = from_node.rowid
      JOIN nodes AS to_node ON to_node.id = edges.to_node
      JOIN node_spatial AS to_spatial ON to_spatial.row_id = to_node.rowid
      WHERE edge_spatial.max_lon >= ? AND edge_spatial.min_lon <= ?
        AND edge_spatial.max_lat >= ? AND edge_spatial.min_lat <= ?
        AND from_spatial.max_lon >= ? AND from_spatial.min_lon <= ?
        AND from_spatial.max_lat >= ? AND from_spatial.min_lat <= ?
        AND to_spatial.max_lon >= ? AND to_spatial.min_lon <= ?
        AND to_spatial.max_lat >= ? AND to_spatial.min_lat <= ?
      ORDER BY edges.id`).iterate(...Array.from({ length: 3 }, () => [west, east, south, north]).flat());
    const physicalEdges = new Set<number>();
    let visited = 0;
    // for-of closes the SQLite iterator on cancellation, errors, and consumer return.
    for (const row of rows) {
      if (++visited % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      assertNotAborted(query.signal);
      const physicalEdgeKey = requiredNumber(row, "physical_edge_key");
      if (physicalEdges.has(physicalEdgeKey)) continue;
      const flags = jsonArray<string>(row.flags, "edge flags");
      const edge: MapTrailEdge = {
        id: requiredString(row, "id"), physicalEdgeKey,
        coordinates: parseCoordinates(row.geometry),
        lengthMeters: requiredNumber(row, "length_m"),
        trailName: flags.find((flag) => flag.startsWith("trail-name:"))?.slice("trail-name:".length) || null,
        accessState: parseAccessState(requiredString(row, "access_state")),
        edgeClass: parseEdgeClass(row.edge_class),
        sourceIds: jsonArray<string>(row.source_refs, "edge source_refs"), flags,
      };
      if (!edgeIsTraversable(edge, query.includeUncertainAccess)
        || !edge.coordinates.every((coordinate) => coordinateIsInsideBbox(coordinate, query.bbox))) continue;
      physicalEdges.add(physicalEdgeKey);
      yield edge;
    }
  }

  async getAccessPointCandidates(query: AccessPointCandidateQuery): Promise<AccessPointCandidate[]> {
    assertNotAborted(query.signal);
    const [west, south, east, north] = query.bbox;
    const rows = this.#database.prepare(
      `SELECT access_points.*, nodes.lon AS candidate_lon, nodes.lat AS candidate_lat, access_topology.can_reach_cycle, access_topology.minimum_stem_distance_m AS inclusive_minimum_stem_m, known.minimum_stem_distance_m AS known_minimum_stem_m
       FROM access_points
       JOIN nodes ON nodes.id = access_points.node_id
       JOIN node_spatial ON node_spatial.row_id = nodes.rowid
       LEFT JOIN access_topology ON access_topology.access_point_id = access_points.id AND access_topology.profile = 'inclusive'
       LEFT JOIN access_topology AS known ON known.access_point_id = access_points.id AND known.profile = 'known'
       WHERE node_spatial.min_lon <= ? AND node_spatial.max_lon >= ?
         AND node_spatial.min_lat <= ? AND node_spatial.max_lat >= ?
         ${query.accessPointId === undefined ? "" : "AND access_points.id = ?"}
       ORDER BY access_points.id`,
    ).all(east, west, north, south, ...(query.accessPointId === undefined ? [] : [query.accessPointId])) as SqliteRow[];
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
        canReachCycle: requiredNumber(row, "can_reach_cycle") === 1,
        knownMinimumStemMeters: parseMinimumStem(row, "known_minimum_stem_m"),
        inclusiveMinimumStemMeters: parseMinimumStem(row, "inclusive_minimum_stem_m"),
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
    // The selected start is already supplied by the solver. Loading every pack
    // access point here would repeat an unbounded scan for each candidate start.
    return { graph: { nodes, edges, accessPoints: [] }, truncated };
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
