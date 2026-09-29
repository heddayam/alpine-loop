import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { canonicalTopologyJson } from "@/lib/graph/topology-hash";
import { deriveProgressivePortals } from "./portals";
import type { AreaGeometry } from "../area-geometry";
import type { SourceSnapshot } from "../adapters";
import type { BuildingCentroid } from "../osm/buildings";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";

export type ProgressiveGraphStoreOptions = { stagingPath: string; buildIdentity: string; deferLookupIndexes?: boolean };

const lookupIndexes = {
  ways: "CREATE INDEX IF NOT EXISTS way_nodes_node ON way_nodes(node_id,way_id)",
  edges: `CREATE INDEX IF NOT EXISTS edges_physical ON edges(stable_physical_id,id);
    CREATE INDEX IF NOT EXISTS edges_from ON edges(from_node);
    CREATE INDEX IF NOT EXISTS edges_to ON edges(to_node)`,
};

function canonicalRecord<T extends { sourceRefs?: string[] }>(record: T): string {
  return JSON.stringify({ ...record, ...(record.sourceRefs ? { sourceRefs: [...new Set(record.sourceRefs)].sort() } : {}) });
}

/** Overlapping extracts can describe one identity with different provenance. */
function mergeProvenance(previous: string, incoming: string): string | null {
  if (previous === incoming) return previous;
  const left = JSON.parse(previous), right = JSON.parse(incoming);
  const { sourceRefs: leftRefs, ...leftValue } = left;
  const { sourceRefs: rightRefs, ...rightValue } = right;
  if (!Array.isArray(leftRefs) || !Array.isArray(rightRefs)
    || canonicalTopologyJson(leftValue) !== canonicalTopologyJson(rightValue)) return null;
  return canonicalRecord({ ...left, sourceRefs: [...leftRefs, ...rightRefs] });
}

/** Persistent, geometry-independent source union. Each put is idempotent on resume. */
export class ProgressiveGraphStore {
  readonly database: DatabaseSync;
  readonly stagingPath: string;
  readonly buildIdentity: string;
  private closed = false;
  // Only fixed SQL from this store's methods is cached; no imported identities or records.
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: ProgressiveGraphStoreOptions) {
    mkdirSync(path.dirname(options.stagingPath), { recursive: true });
    this.stagingPath = options.stagingPath;
    this.buildIdentity = options.buildIdentity;
    this.database = new DatabaseSync(options.stagingPath);
    // Rebuildable working data: keep transactions atomic without a WAL sync on
    // every small import batch. Cache memory stays bounded independently of size.
    this.database.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,lon REAL NOT NULL,lat REAL NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS ways(id TEXT PRIMARY KEY,external_id TEXT NOT NULL,edge_class TEXT NOT NULL,access_state TEXT NOT NULL,bidirectional INTEGER NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS way_nodes(way_id TEXT NOT NULL,node_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(way_id,ordinal)) STRICT;
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,kind TEXT NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS buildings(id INTEGER PRIMARY KEY,lon REAL NOT NULL,lat REAL NOT NULL,UNIQUE(lon,lat)) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS building_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,stable_physical_id TEXT NOT NULL,from_node TEXT NOT NULL,to_node TEXT NOT NULL,access_state TEXT NOT NULL,edge_class TEXT NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS access_points(id TEXT PRIMARY KEY,node_id TEXT NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS derived_portals(coverage_hash TEXT NOT NULL,id TEXT NOT NULL,node_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(coverage_hash,id)) STRICT;
      CREATE INDEX IF NOT EXISTS derived_portals_node ON derived_portals(coverage_hash,node_id);
    `);
    if (!options.deferLookupIndexes) for (const sql of Object.values(lookupIndexes)) this.database.exec(sql);
    const row = this.database.prepare("SELECT value FROM store_meta WHERE key='buildIdentity'").get() as { value: string } | undefined;
    if (row && row.value !== options.buildIdentity) {
      this.database.close();
      throw new Error(`Progressive store identity mismatch: ${row.value} versus ${options.buildIdentity}`);
    }
    if (!row) this.database.prepare("INSERT INTO store_meta VALUES ('buildIdentity',?)").run(options.buildIdentity);
  }

  /** Bulk preparation can build lookup indexes once when each phase needs them. */
  async prepareLookupIndexes(phase: keyof typeof lookupIndexes, checkpoint: () => Promise<void> = async () => {}): Promise<void> {
    this.assertOpen();
    await checkpoint();
    this.database.exec(lookupIndexes[phase]);
    await checkpoint();
  }

  private assertOpen(): void { if (this.closed) throw new Error("Progressive graph store is closed"); }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.database.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private put(table: "ways" | "evidence" | "sources" | "edges" | "access_points", id: string, columns: string[], values: Array<string | number | null>, record: string): boolean {
    this.assertOpen();
    const prior = this.statement(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
    if (prior) {
      const merged = mergeProvenance(prior.record, record);
      if (merged === null) throw new Error(`Conflicting progressive ${table} record ${id}`);
      if (merged !== prior.record) this.statement(`UPDATE ${table} SET record=? WHERE id=?`).run(merged, id);
      return false;
    }
    const marks = Array(columns.length + 2).fill("?").join(",");
    this.statement(`INSERT INTO ${table}(id${columns.length ? `,${columns.join(",")}` : ""},record) VALUES (${marks})`).run(id, ...values, record);
    return true;
  }
  transaction<T>(action: () => T): T {
    this.assertOpen(); this.database.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.database.exec("COMMIT"); return value; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  putNode(node: NormalizedNode): void {
    this.assertOpen();
    const prior = this.statement("SELECT record FROM nodes WHERE id=?").get(node.id) as {record:string}|undefined;
    if (prior) {
      const existing = JSON.parse(prior.record) as NormalizedNode;
      const merged = mergeProvenance(canonicalRecord({...existing,elevationM:null}), canonicalRecord({...node,elevationM:null}));
      if (merged === null) throw new Error(`Conflicting progressive nodes record ${node.id}`);
      const record = canonicalRecord({ ...JSON.parse(merged), elevationM: existing.elevationM });
      if (record !== prior.record) this.statement("UPDATE nodes SET record=? WHERE id=?").run(record, node.id);
      if (node.elevationM !== null) this.writeNodeElevation(node.id,node.elevationM,JSON.parse(record) as NormalizedNode);
    } else {
      this.statement("INSERT INTO nodes(id,lon,lat,record) VALUES (?,?,?,?)").run(node.id,node.lon,node.lat,canonicalRecord(node));
    }
  }
  private writeNodeElevation(id: string, elevationM: number, node: NormalizedNode): void {
    if (!Number.isFinite(elevationM)) throw new Error(`Invalid elevation for ${id}`);
    if (node.elevationM !== null && node.elevationM !== elevationM) throw new Error(`Conflicting elevation for ${id}`);
    if (node.elevationM === null) this.statement("UPDATE nodes SET record=? WHERE id=?").run(canonicalRecord({...node,elevationM}),id);
  }
  setNodeElevation(id: string, elevationM: number): void {
    this.assertOpen();
    if (!Number.isFinite(elevationM)) throw new Error(`Invalid elevation for ${id}`);
    const row = this.statement("SELECT record FROM nodes WHERE id=?").get(id) as {record:string}|undefined;
    if (!row) throw new Error(`Unknown progressive node ${id}`);
    this.writeNodeElevation(id,elevationM,JSON.parse(row.record) as NormalizedNode);
  }
  putWay(way: NormalizedWay): void {
    const inserted = this.put("ways", way.id, ["external_id","edge_class","access_state","bidirectional"],
      [way.externalId,way.edgeClass ?? "trail",way.accessState,Number(way.bidirectional)],canonicalRecord(way));
    if (!inserted) {
      const row = this.statement("SELECT count(*) AS n FROM way_nodes WHERE way_id=?").get(way.id) as {n:number};
      if (row.n === way.nodeIds.length) return;
    }
    this.statement("INSERT OR IGNORE INTO way_nodes SELECT ?,value,CAST(key AS INTEGER) FROM json_each(?)")
      .run(way.id,JSON.stringify(way.nodeIds));
  }
  putPortalEvidence(item: NormalizedPortalEvidence): void {
    this.put("evidence", item.id, ["kind"], [item.kind], canonicalRecord(item));
  }
  putBuilding([lon,lat]: BuildingCentroid): void {
    this.assertOpen();
    const inserted = this.statement("INSERT OR IGNORE INTO buildings(lon,lat) VALUES (?,?)").run(lon,lat);
    const row = inserted.changes ? {id:Number(inserted.lastInsertRowid)} : this.statement(`SELECT b.id FROM buildings b
      LEFT JOIN building_spatial s ON s.id=b.id WHERE b.lon=? AND b.lat=? AND s.id IS NULL`).get(lon,lat) as {id:number}|undefined;
    if (row) this.statement("INSERT OR IGNORE INTO building_spatial VALUES (?,?,?,?,?)").run(row.id,lon,lon,lat,lat);
  }
  putSource(source: SourceSnapshot): void {
    const durable = { ...source };
    delete (durable as Partial<SourceSnapshot>).localPath;
    this.put("sources",source.id,[],[],JSON.stringify(durable));
  }
  putEdge(edge: CompiledEdge): void {
    this.put("edges",edge.id,["stable_physical_id","from_node","to_node","access_state","edge_class"],
      [edge.stablePhysicalId,edge.fromNode,edge.toNode,edge.accessState,edge.edgeClass ?? "trail"],canonicalRecord(edge));
  }
  /** Optional fixture/import path. Production builds can derive candidates from ways and evidence. */
  putAccessPoint(point: NormalizedAccessPoint): void {
    this.put("access_points",point.id,["node_id"],[point.nodeId],canonicalRecord(point));
  }
  // Iterators need independent statement lifetimes so callers can interleave reads.
  *iterateNodes(): Iterable<NormalizedNode> {
    this.assertOpen();
    for (const row of this.database.prepare("SELECT record FROM nodes ORDER BY id").iterate() as Iterable<{record:string}>) yield JSON.parse(row.record) as NormalizedNode;
  }
  *iterateWays(): Iterable<NormalizedWay> {
    this.assertOpen();
    for (const row of this.database.prepare("SELECT record FROM ways ORDER BY id").iterate() as Iterable<{record:string}>) yield JSON.parse(row.record) as NormalizedWay;
  }
  *iterateEdges(): Iterable<CompiledEdge> {
    this.assertOpen();
    for (const row of this.database.prepare("SELECT record FROM edges ORDER BY id").iterate() as Iterable<{record:string}>) yield JSON.parse(row.record) as CompiledEdge;
  }
  derivePortals(coverage: AreaGeometry, checkpoint?: () => Promise<void>): Promise<number> { return deriveProgressivePortals(this,coverage,checkpoint); }
  close(): void { if (!this.closed) { this.database.close(); this.statements.clear(); this.closed=true; } }
}
export function openProgressiveGraphStore(options: ProgressiveGraphStoreOptions): ProgressiveGraphStore {
  return new ProgressiveGraphStore(options);
}
