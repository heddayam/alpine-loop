import { DatabaseSync } from "node:sqlite";
import { areaBounds, coordinateIsInsideArea, coordinateIsInsideBbox, edgeIsInsideBbox, lineIsInsideArea, type AreaGeometry, type BoundingBox } from "./geometry";
import { accessPointIsEligible, edgeIsTraversable } from "./policy";
import { assertNotAborted, DistanceQueue, parseAccessPoint, parseEdge, parseMinimumStem, parseNode, requiredNumber, type SqliteRow } from "./sqlite-records";
import type { AccessPointCandidate, AccessPointCandidateQuery, GraphEdge, GraphNode, GraphQuery, GraphRepository, InducedGraph, ReachableGraphQuery, ReachableGraphResult } from "./types";

export type PreparedGraphDescriptor = {
  releaseId: string;
  installationId: string;
  artifacts: readonly { path: string; geometry: AreaGeometry }[];
  coverage: AreaGeometry;
};
type Artifact = PreparedGraphDescriptor["artifacts"][number] & { bounds: BoundingBox };
const MAXIMUM_CONNECTIONS = 8;
const BATCH_SIZE = 256;

// SQLite BINARY compares UTF-8 bytes; locale collation can reorder stable IDs.
const compareIds = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function insertConsistent<T>(values: Map<string, T>, id: string, value: T): void {
  const previous = values.get(id);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
    throw new Error(`Graph database corruption: conflicting release record ${id}`);
  }
  values.set(id, value);
}

/**
 * One logical graph over immutable release pieces. Node coordinates select every
 * touching piece, so seams/corners need neither a global node index nor a merge DB.
 * Every SQLite operation ends before yielding: the LRU can always evict safely.
 */
export class PreparedGraphRepository implements GraphRepository {
  readonly packId: string;
  readonly releaseId: string;
  readonly #artifacts: Artifact[];
  readonly #coverage: AreaGeometry;
  readonly #pool = new Map<string, DatabaseSync>();
  #closed = false;
  #peakConnections = 0;

  constructor(descriptor: PreparedGraphDescriptor) {
    if (!descriptor.releaseId || !descriptor.installationId) throw new Error("Prepared graph identity is required");
    this.packId = descriptor.installationId;
    this.releaseId = descriptor.releaseId;
    this.#coverage = structuredClone(descriptor.coverage);
    this.#artifacts = descriptor.artifacts.map(artifact => ({
      ...structuredClone(artifact), bounds: areaBounds(artifact.geometry),
    })).sort((a, b) => a.path.localeCompare(b.path));
  }

  get connectionStats(): { open: number; peak: number; limit: number } {
    return { open: this.#pool.size, peak: this.#peakConnections, limit: MAXIMUM_CONNECTIONS };
  }

  #database(path: string): DatabaseSync {
    if (this.#closed) throw new Error("Prepared graph repository is closed");
    const cached = this.#pool.get(path);
    if (cached) {
      this.#pool.delete(path);
      this.#pool.set(path, cached);
      return cached;
    }
    if (this.#pool.size === MAXIMUM_CONNECTIONS) {
      const [oldest, database] = this.#pool.entries().next().value!;
      database.close();
      this.#pool.delete(oldest);
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const metadata = new Map(database.prepare("SELECT key, value FROM metadata").all().map(row => [row.key, row.value]));
      if (metadata.get("schemaVersion") !== "7") throw new Error("expected schema version 7");
      if (metadata.get("releaseId") !== this.releaseId) throw new Error("release identity mismatch");
      database.prepare("SELECT known_minimum_stem_m, inclusive_minimum_stem_m FROM access_points LIMIT 0");
      database.exec("PRAGMA cache_size = -2048");
    } catch (error) {
      database.close();
      throw new Error(`Graph database corruption: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#pool.set(path, database);
    this.#peakConnections = Math.max(this.#peakConnections, this.#pool.size);
    return database;
  }

  #at(coordinate: readonly [number, number]): Artifact[] {
    return this.#artifacts.filter(artifact => coordinateIsInsideBbox(coordinate, artifact.bounds)
      && coordinateIsInsideArea(coordinate, artifact.geometry));
  }

  #hasInstalledDeparture(id: string, coordinate: readonly [number, number], includeUncertainAccess: boolean, signal?: AbortSignal): boolean {
    for (const artifact of this.#at(coordinate)) {
      const rows = this.#database(artifact.path).prepare("SELECT * FROM edges WHERE from_node = ?").iterate(id);
      for (const row of rows) {
        assertNotAborted(signal);
        const edge = parseEdge(row);
        if (edgeIsTraversable(edge, includeUncertainAccess) && lineIsInsideArea(edge.coordinates, this.#coverage)) return true;
      }
    }
    return false;
  }

  async getAccessPointCandidates(query: AccessPointCandidateQuery): Promise<AccessPointCandidate[]> {
    assertNotAborted(query.signal);
    const points = new Map<string, AccessPointCandidate>();
    const [west, south, east, north] = query.bbox;
    for (const artifact of this.#artifacts.filter(artifact => intersects(query.bbox, artifact.bounds))) {
      let after = "";
      while (true) {
        assertNotAborted(query.signal);
        const rows = this.#database(artifact.path).prepare(`SELECT a.*, n.lon AS candidate_lon, n.lat AS candidate_lat
          FROM access_points a JOIN nodes n ON n.id = a.node_id
          JOIN node_spatial s ON s.row_id = n.node_key
          WHERE s.max_lon >= ? AND s.min_lon <= ? AND s.max_lat >= ? AND s.min_lat <= ?
            AND a.id > ? ${query.accessPointId === undefined ? "" : "AND a.id = ?"}
          ORDER BY a.id LIMIT ?`).all(west, east, south, north, after,
            ...(query.accessPointId === undefined ? [] : [query.accessPointId]), BATCH_SIZE) as SqliteRow[];
        for (const row of rows) {
          const point = parseAccessPoint(row);
          const lon = requiredNumber(row, "candidate_lon"), lat = requiredNumber(row, "candidate_lat");
          const knownMinimumStemMeters = parseMinimumStem(row, "known_minimum_stem_m");
          const inclusiveMinimumStemMeters = parseMinimumStem(row, "inclusive_minimum_stem_m");
          if (knownMinimumStemMeters !== null && (inclusiveMinimumStemMeters === null || inclusiveMinimumStemMeters > knownMinimumStemMeters)) {
            throw new Error("Graph database corruption: inconsistent profile hints");
          }
          if (!coordinateIsInsideBbox([lon, lat], query.bbox)
            || !coordinateIsInsideArea([lon, lat], this.#coverage)
            || !accessPointIsEligible(point, query.includeUncertainAccess)
            || !this.#hasInstalledDeparture(point.nodeId, [lon, lat], query.includeUncertainAccess, query.signal)) continue;
          insertConsistent(points, point.id, {
            ...point, lon, lat, knownMinimumStemMeters, inclusiveMinimumStemMeters,
            canReachCycle: inclusiveMinimumStemMeters !== null,
            knownConnectivity: requiredNumber(row, "known_connectivity"),
            inclusiveConnectivity: requiredNumber(row, "inclusive_connectivity"),
            knownOutDegree: requiredNumber(row, "known_out_degree"),
            inclusiveOutDegree: requiredNumber(row, "inclusive_out_degree"),
          });
        }
        if (rows.length < BATCH_SIZE) break;
        after = String(rows.at(-1)!.id);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    return [...points.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async *iterateMapTrails(query: GraphQuery): AsyncGenerator<GraphEdge> {
    const physicalKeys = new Set<number>();
    for await (const edge of this.#viewportEdges(query)) {
      if (physicalKeys.has(edge.physicalEdgeKey!)) continue;
      physicalKeys.add(edge.physicalEdgeKey!);
      yield edge;
    }
  }

  async *#viewportEdges(query: GraphQuery): AsyncGenerator<GraphEdge> {
    const seen = new Set<string>();
    const [west, south, east, north] = query.bbox;
    for (const artifact of this.#artifacts.filter(artifact => intersects(query.bbox, artifact.bounds))) {
      let after = "";
      while (true) {
        assertNotAborted(query.signal);
        const rows = this.#database(artifact.path).prepare(`SELECT e.* FROM edges e
          JOIN edge_spatial s ON s.row_id = e.edge_key
          WHERE s.max_lon >= ? AND s.min_lon <= ? AND s.max_lat >= ? AND s.min_lat <= ?
          AND e.id > ? ORDER BY e.id LIMIT ?`).all(west, east, south, north, after, BATCH_SIZE) as SqliteRow[];
        for (const row of rows) {
          const edge = parseEdge(row);
          if (seen.has(edge.id) || !edgeIsTraversable(edge, query.includeUncertainAccess)
            || !edgeIsInsideBbox(edge, query.bbox) || !lineIsInsideArea(edge.coordinates, this.#coverage)) continue;
          seen.add(edge.id);
          yield edge;
        }
        if (rows.length < BATCH_SIZE) break;
        after = String(rows.at(-1)!.id);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  }

  async getInducedGraph(query: GraphQuery): Promise<InducedGraph> {
    const nodes = new Map<string, GraphNode>(), edges: GraphEdge[] = [];
    for await (const edge of this.#viewportEdges(query)) {
      edges.push(edge);
      for (const [id, coordinate] of [[edge.fromNodeId, edge.coordinates[0]], [edge.toNodeId, edge.coordinates.at(-1)!]] as const) {
        if (!nodes.has(id)) {
          const node = this.#node(id, this.#at(coordinate));
          if (!node) throw new Error(`Graph database corruption: missing endpoint ${id}`);
          nodes.set(id, node);
        }
      }
    }
    const accessPoints = await this.getAccessPointCandidates(query);
    for (const point of accessPoints) {
      if (!nodes.has(point.nodeId)) {
        const node = this.#node(point.nodeId, this.#at([point.lon, point.lat]));
        if (node) nodes.set(node.id, node);
      }
    }
    return { nodes, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), accessPoints };
  }

  #node(id: string, artifacts: readonly Artifact[]): GraphNode | undefined {
    let found: GraphNode | undefined;
    for (const artifact of artifacts) {
      const row = this.#database(artifact.path).prepare("SELECT * FROM nodes WHERE id = ?").get(id) as SqliteRow | undefined;
      if (row) {
        const node = parseNode(row);
        if (found && JSON.stringify(node) !== JSON.stringify(found)) throw new Error(`Graph database corruption: conflicting node ${id}`);
        found = node;
      }
    }
    return found;
  }

  async getReachableGraph(query: ReachableGraphQuery): Promise<ReachableGraphResult> {
    assertNotAborted(query.signal);
    if (!query.startCoordinates) throw new Error("Prepared graph queries require startCoordinates");
    const start = this.#node(query.startNodeId, this.#at(query.startCoordinates));
    const nodes = new Map<string, GraphNode>(), edges = new Map<string, GraphEdge>();
    if (!start || !coordinateIsInsideArea([start.lon, start.lat], this.#coverage)) {
      return { graph: { nodes, edges: [], accessPoints: [] }, truncated: false };
    }
    nodes.set(start.id, start);
    const pending = new DistanceQueue(), distances = new Map([[start.id, 0]]);
    pending.push({ nodeId: start.id, distance: 0 });
    let visited = 0, truncated = false;
    search: while (pending.size) {
      if (++visited % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      assertNotAborted(query.signal);
      const current = pending.pop()!;
      if (current.distance !== distances.get(current.nodeId)) continue;
      const node = nodes.get(current.nodeId)!;
      const adjacency = new Map<string, GraphEdge>();
      for (const artifact of this.#at([node.lon, node.lat])) {
        const rows = this.#database(artifact.path).prepare("SELECT * FROM edges WHERE from_node = ? ORDER BY id").iterate(node.id);
        let eligibleInArtifact = 0;
        for (const row of rows) {
          assertNotAborted(query.signal);
          const edge = parseEdge(row);
          if (!edgeIsTraversable(edge, query.includeUncertainAccess)
            || current.distance + edge.lengthMeters > query.maximumDistanceMeters
            || !lineIsInsideArea(edge.coordinates, this.#coverage)
            || !lineIsInsideArea(edge.coordinates, query.coverage)) continue;
          insertConsistent(adjacency, edge.id, edge);
          // At most one extra eligible edge is needed to prove truncation.
          if (++eligibleInArtifact > query.maximumDirectedEdges) break;
        }
        if (adjacency.size > query.maximumDirectedEdges + 1) {
          const keep = [...adjacency.keys()].sort(compareIds).slice(0, query.maximumDirectedEdges + 1);
          const keys = new Set(keep);
          for (const id of adjacency.keys()) if (!keys.has(id)) adjacency.delete(id);
        }
      }
      for (const edge of [...adjacency.values()].sort((a, b) => compareIds(a.id, b.id))) {
        if (!edges.has(edge.id) && edges.size >= query.maximumDirectedEdges) { truncated = true; break search; }
        insertConsistent(edges, edge.id, edge);
        let to = nodes.get(edge.toNodeId);
        if (!to) {
          to = this.#node(edge.toNodeId, this.#at(edge.coordinates.at(-1)!));
          if (!to) throw new Error(`Graph database corruption: missing endpoint ${edge.toNodeId}`);
          nodes.set(to.id, to);
        }
        const distance = current.distance + edge.lengthMeters;
        if (distance < (distances.get(to.id) ?? Infinity)) {
          distances.set(to.id, distance);
          pending.push({ nodeId: to.id, distance });
        }
      }
    }
    return { graph: { nodes, edges: [...edges.values()], accessPoints: [] }, truncated };
  }

  async close(): Promise<void> {
    for (const database of this.#pool.values()) database.close();
    this.#pool.clear();
    this.#closed = true;
  }
}
