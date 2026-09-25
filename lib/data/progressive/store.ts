import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deriveProgressivePortals } from "./portals";
import type { AreaGeometry } from "../area-geometry";
import type { SourceSnapshot } from "../adapters";
import type { BuildingCentroid } from "../osm/buildings";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";

export type ProgressiveGraphStoreOptions = { stagingPath: string; buildIdentity: string };
export type StageReceipt = { stage: string; fingerprint: string; rowCount: number; contentHash: string };

function canonicalRecord<T extends { sourceRefs?: string[] }>(record: T): string {
  return JSON.stringify({ ...record, ...(record.sourceRefs ? { sourceRefs: [...new Set(record.sourceRefs)].sort() } : {}) });
}

/** Persistent, geometry-independent source union. Each put is idempotent on resume. */
export class ProgressiveGraphStore {
  readonly database: DatabaseSync;
  readonly stagingPath: string;
  readonly buildIdentity: string;
  private closed = false;

  constructor(options: ProgressiveGraphStoreOptions) {
    mkdirSync(path.dirname(options.stagingPath), { recursive: true });
    this.stagingPath = options.stagingPath;
    this.buildIdentity = options.buildIdentity;
    this.database = new DatabaseSync(options.stagingPath);
    this.database.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,lon REAL NOT NULL,lat REAL NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);
      CREATE TABLE IF NOT EXISTS ways(id TEXT PRIMARY KEY,external_id TEXT NOT NULL,edge_class TEXT NOT NULL,access_state TEXT NOT NULL,bidirectional INTEGER NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS way_nodes(way_id TEXT NOT NULL,node_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(way_id,ordinal)) STRICT;
      CREATE INDEX IF NOT EXISTS way_nodes_node ON way_nodes(node_id,way_id);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,kind TEXT NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_points(id INTEGER PRIMARY KEY,evidence_id TEXT NOT NULL,lon REAL NOT NULL,lat REAL NOT NULL) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);
      CREATE UNIQUE INDEX IF NOT EXISTS evidence_points_unique ON evidence_points(evidence_id,lon,lat);
      CREATE TABLE IF NOT EXISTS buildings(id INTEGER PRIMARY KEY,lon REAL NOT NULL,lat REAL NOT NULL,UNIQUE(lon,lat)) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS building_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,stable_physical_id TEXT NOT NULL,from_node TEXT NOT NULL,to_node TEXT NOT NULL,access_state TEXT NOT NULL,edge_class TEXT NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS edges_physical ON edges(stable_physical_id,id);
      CREATE INDEX IF NOT EXISTS edges_from ON edges(from_node);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(to_node);
      CREATE TABLE IF NOT EXISTS access_points(id TEXT PRIMARY KEY,node_id TEXT NOT NULL,record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS receipts(stage TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,row_count INTEGER NOT NULL,content_hash TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS derived_portals(coverage_hash TEXT NOT NULL,id TEXT NOT NULL,node_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(coverage_hash,id)) STRICT;
      CREATE INDEX IF NOT EXISTS derived_portals_node ON derived_portals(coverage_hash,node_id);
    `);
    const row = this.database.prepare("SELECT value FROM store_meta WHERE key='buildIdentity'").get() as { value: string } | undefined;
    if (row && row.value !== options.buildIdentity) {
      this.database.close();
      throw new Error(`Progressive store identity mismatch: ${row.value} versus ${options.buildIdentity}`);
    }
    if (!row) this.database.prepare("INSERT INTO store_meta VALUES ('buildIdentity',?)").run(options.buildIdentity);
  }

  private assertOpen(): void { if (this.closed) throw new Error("Progressive graph store is closed"); }
  private put(table: "nodes" | "ways" | "evidence" | "sources" | "edges" | "access_points", id: string, columns: string[], values: Array<string | number | null>, record: string): boolean {
    this.assertOpen();
    const prior = this.database.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
    if (prior) {
      if (prior.record !== record) throw new Error(`Conflicting progressive ${table} record ${id}`);
      return false;
    }
    const marks = Array(columns.length + 2).fill("?").join(",");
    this.database.prepare(`INSERT INTO ${table}(id${columns.length ? `,${columns.join(",")}` : ""},record) VALUES (${marks})`).run(id, ...values, record);
    return true;
  }
  transaction<T>(action: () => T): T {
    this.assertOpen(); this.database.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.database.exec("COMMIT"); return value; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  putNode(node: NormalizedNode): void {
    this.assertOpen();
    const prior = this.database.prepare("SELECT rowid,record FROM nodes WHERE id=?").get(node.id) as {rowid:number;record:string}|undefined;
    if (prior) {
      const existing = JSON.parse(prior.record) as NormalizedNode;
      if (canonicalRecord({...existing,elevationM:null}) !== canonicalRecord({...node,elevationM:null}))
        throw new Error(`Conflicting progressive nodes record ${node.id}`);
      if (node.elevationM !== null) this.setNodeElevation(node.id,node.elevationM);
    } else {
      this.put("nodes", node.id, ["lon","lat"], [node.lon,node.lat], canonicalRecord(node));
    }
    const row = this.database.prepare("SELECT rowid FROM nodes WHERE id=?").get(node.id) as {rowid:number};
    this.database.prepare("INSERT OR IGNORE INTO nodes_spatial VALUES (?,?,?,?,?)").run(row.rowid,node.lon,node.lon,node.lat,node.lat);
  }
  setNodeElevation(id: string, elevationM: number): void {
    this.assertOpen();
    if (!Number.isFinite(elevationM)) throw new Error(`Invalid elevation for ${id}`);
    const row = this.database.prepare("SELECT record FROM nodes WHERE id=?").get(id) as {record:string}|undefined;
    if (!row) throw new Error(`Unknown progressive node ${id}`);
    const node = JSON.parse(row.record) as NormalizedNode;
    if (node.elevationM !== null && node.elevationM !== elevationM) throw new Error(`Conflicting elevation for ${id}`);
    if (node.elevationM === null) this.database.prepare("UPDATE nodes SET record=? WHERE id=?").run(canonicalRecord({...node,elevationM}),id);
  }
  putWay(way: NormalizedWay): void {
    this.put("ways", way.id, ["external_id","edge_class","access_state","bidirectional"],
      [way.externalId,way.edgeClass ?? "trail",way.accessState,Number(way.bidirectional)],canonicalRecord(way));
    {
      const insert = this.database.prepare("INSERT OR IGNORE INTO way_nodes VALUES (?,?,?)");
      way.nodeIds.forEach((nodeId, ordinal) => insert.run(way.id,nodeId,ordinal));
    }
  }
  putPortalEvidence(item: NormalizedPortalEvidence): void {
    this.put("evidence", item.id, ["kind"], [item.kind], canonicalRecord(item));
    {
      const insert = this.database.prepare("INSERT OR IGNORE INTO evidence_points(evidence_id,lon,lat) VALUES (?,?,?)");
      const spatial = this.database.prepare("INSERT INTO evidence_spatial VALUES (?,?,?,?,?)");
      const coordinates = item.coordinates.length ? item.coordinates : item.nodeIds.flatMap((nodeId) => {
        const row = this.database.prepare("SELECT lon,lat FROM nodes WHERE id=?").get(nodeId) as {lon:number;lat:number}|undefined;
        return row ? [[row.lon,row.lat] as const] : [];
      });
      for (const [lon,lat] of coordinates) {
        const result = insert.run(item.id,lon,lat);
        if (result.changes) { const id = Number(result.lastInsertRowid); spatial.run(id,lon,lon,lat,lat); }
      }
    }
  }
  putBuilding([lon,lat]: BuildingCentroid): void {
    this.assertOpen();
    this.database.prepare("INSERT OR IGNORE INTO buildings(lon,lat) VALUES (?,?)").run(lon,lat);
    const row = this.database.prepare("SELECT id FROM buildings WHERE lon=? AND lat=?").get(lon,lat) as {id:number};
    this.database.prepare("INSERT OR IGNORE INTO building_spatial VALUES (?,?,?,?,?)").run(row.id,lon,lon,lat,lat);
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
  getReceipt(stage: string): StageReceipt | null {
    this.assertOpen();
    const row=this.database.prepare("SELECT stage,fingerprint,row_count AS rowCount,content_hash AS contentHash FROM receipts WHERE stage=?").get(stage);
    return row ? row as StageReceipt : null;
  }
  putReceipt(receipt: StageReceipt): void {
    this.assertOpen();
    this.database.prepare("INSERT INTO receipts VALUES (?,?,?,?) ON CONFLICT(stage) DO UPDATE SET fingerprint=excluded.fingerprint,row_count=excluded.row_count,content_hash=excluded.content_hash")
      .run(receipt.stage,receipt.fingerprint,receipt.rowCount,receipt.contentHash);
  }
  close(): void { if (!this.closed) { this.database.close(); this.closed=true; } }
}
export function openProgressiveGraphStore(options: ProgressiveGraphStoreOptions): ProgressiveGraphStore {
  return new ProgressiveGraphStore(options);
}
