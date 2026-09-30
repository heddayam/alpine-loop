import { DatabaseSync } from "node:sqlite";
import { checkSQLiteIntegrity } from "@/lib/data/sqlite-integrity";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { filteredSourceLines } from "./source-filter";
import { buildingCentroidOf, parseBuildingCentroids } from "@/lib/data/osm/buildings";
import { parseOplTags } from "@/lib/data/osm/opl";
import { classifyOsmWay, hasOsmNodeContext, osmAccessState, osmEvidenceFlags, osmFootDirection, osmNodeFlags, osmPortalEvidenceKinds, osmWayFlags } from "@/lib/data/osm/normalize";
import type { NormalizedNode, NormalizedWay, NormalizedPortalEvidence } from "@/lib/data/types";
import type { SourceSnapshot } from "@/lib/data/adapters";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { areaBounds } from "@/lib/graph/geometry";

type Row = { id: string; refs: string; tags: string; kind: string; coordinates: string; minx: number; maxx: number; miny: number; maxy: number };
type WalkingEntry = {way:NormalizedWay; nodes:NormalizedNode[]};
export type CoverageContextEntry =
  | ({kind:"way"} & WalkingEntry)
  | {kind:"building"; centroid:readonly [number,number]}
  | {kind:"evidence"; evidence:NormalizedPortalEvidence};
type Envelope = readonly [east:number,west:number,north:number,south:number];
type Node = { id: string; lon: number; lat: number; tags: string };
function componentEnvelopes(area: AreaGeometry, context: number): Envelope[] {
  const polygons=area.type==="Polygon"?[area.coordinates]:area.coordinates;
  return polygons.map(coordinates=>{
    const [w,s,e,n]=areaBounds({type:"Polygon",coordinates});
    return [e+context,w-context,n+context,s-context] as const;
  });
}
const componentBounds = (area: AreaGeometry, context: number) => JSON.stringify(componentEnvelopes(area,context));
function intersectsEnvelopes(row: Row, envelopes: readonly Envelope[]): boolean {
  return envelopes.some(([east,west,north,south])=>row.minx<=east&&row.maxx>=west&&row.miny<=north&&row.maxy>=south);
}
function walkingEntry(row: Row, tags: Record<string,string>, refs: string[], coordinates: [number,number][], sourceId: string,
  nodeFlags: ReadonlyMap<string, string[]>): WalkingEntry {
  const direction=osmFootDirection(tags);
  if(direction==="reverse") {refs=[...refs].reverse();coordinates=[...coordinates].reverse();}
  const nodes=refs.map((id,index)=>({id:`osm-node-${id}`,externalId:`node/${id}`,lon:coordinates[index]![0],lat:coordinates[index]![1],elevationM:null,flags:nodeFlags.get(id)??[],sourceRefs:[sourceId]}));
  return {nodes,way:{id:`osm-way-${row.id}`,externalId:`way/${row.id}`,nodeIds:nodes.map(node=>node.id),coordinates,name:tags.name??null,accessState:osmAccessState(tags),bidirectional:direction==="both",edgeClass:row.kind as NormalizedWay["edgeClass"],sourceRefs:[sourceId],flags:osmWayFlags(tags,`way/${row.id}`,direction)}};
}
function* portalEvidence(externalId: string, tags: Record<string,string>, nodeIds: string[], coordinates: [number,number][], sourceId: string): Generator<NormalizedPortalEvidence> {
  for(const kind of osmPortalEvidenceKinds(tags)) yield {id:`osm-evidence-${kind}-${externalId.replace("/","-")}`,externalId,kind,name:tags.name??null,nodeIds,coordinates,accessState:osmAccessState(tags),flags:osmEvidenceFlags(tags),sourceRefs:[sourceId]};
}
function nodeBuilding(row: Node, tags: Record<string,string>): readonly [number,number] | null {
  return isBuilding(tags) ? buildingCentroidOf({type:"Point",coordinates:[row.lon,row.lat]}) : null;
}
const SEAL_KEY = "compact-seal-v1";
const COMPLETE_KEY = "compact-import-v1";
const CHECKPOINT_ROWS = 10_000;
export const NORMALIZATION_VERSION = "source-normalization-v11";
const geometryHash = (geometry: AreaGeometry) => createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
export const sourceStoreFileName = (source: SourceSnapshot, geometry: AreaGeometry) =>
  `source-${NORMALIZATION_VERSION}-${source.contentHash.slice(7)}-${geometryHash(geometry).slice(0, 24)}.sqlite`;

// OSM uses building=yes or a building type; building=no explicitly denies one.
// https://wiki.openstreetmap.org/wiki/Tag:building%3Dno
function isBuilding(tags: Record<string, string>): boolean {
  return Boolean(tags.building) && tags.building !== "no";
}

class UnsupportedBuildingGeometry extends Error {}

/** Join outer member fragments by OSM node identity, preserving closed-ring centroid semantics. */
function outerRings(parts: string[][]): string[][] {
  const pending = parts.map((part) => [...part]);
  const rings: string[][] = [];
  while (pending.length) {
    const ring = pending.pop()!;
    while (ring.at(-1) !== ring[0]) {
      const index = pending.findIndex((part) => part[0] === ring.at(-1) || part.at(-1) === ring.at(-1));
      if (index < 0) throw new UnsupportedBuildingGeometry("Building relation has an incomplete outer ring");
      const next = pending.splice(index, 1)[0]!;
      if (next[0] !== ring.at(-1)) next.reverse();
      ring.push(...next.slice(1));
    }
    if (ring.length < 4) throw new UnsupportedBuildingGeometry("Building relation has a degenerate outer ring");
    rings.push(ring);
  }
  if (!rings.length) throw new UnsupportedBuildingGeometry("Building relation has no outer ways");
  return rings;
}

/** Compact source data; temporary disk joins are discarded before publication. */
export class CoverageSourceStore {
  readonly db: DatabaseSync;
  private spatialReady = false;
  private nodeFlagQuery?: ReturnType<DatabaseSync["prepare"]>;
  constructor(readonly path: string, readonly source: SourceSnapshot, readonly geometry: AreaGeometry) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,lon REAL,lat REAL,tags TEXT);
      CREATE INDEX IF NOT EXISTS nodes_location ON nodes(lon,lat);
      CREATE TABLE IF NOT EXISTS relation_buildings(id TEXT PRIMARY KEY,lon REAL,lat REAL);
      CREATE INDEX IF NOT EXISTS relation_buildings_location ON relation_buildings(lon,lat);
      CREATE TABLE IF NOT EXISTS ways(id TEXT PRIMARY KEY,refs TEXT,tags TEXT,kind TEXT,coordinates TEXT,minx REAL,maxx REAL,miny REAL,maxy REAL);
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory(id TEXT PRIMARY KEY,disposition TEXT NOT NULL,reason TEXT NOT NULL);
    `);
    const identity = `${NORMALIZATION_VERSION}:${source.contentHash}:${geometryHash(geometry)}`;
    const previous = this.db.prepare("SELECT value FROM meta WHERE key='source'").get() as {value:string}|undefined;
    if (previous && previous.value !== identity) { this.db.close(); throw new Error("Staged source fingerprint mismatch"); }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('source',?)").run(identity);
  }
  receipt(key: string): string | undefined { return (this.db.prepare("SELECT value FROM receipts WHERE key=?").get(key) as {value:string}|undefined)?.value; }
  mark(key: string, value = "complete") { this.db.prepare("INSERT OR REPLACE INTO receipts VALUES(?,?)").run(key,value); }
  close() { this.db.close(); }
  private async seal(checkpoint:()=>Promise<void>): Promise<string> {
    await checkpoint();
    await checkSQLiteIntegrity(this.path, this.db, checkpoint);
    this.db.exec("DROP TABLE IF EXISTS temp.ways_spatial; CREATE VIRTUAL TABLE temp.ways_spatial USING rtree(id,minx,maxx,miny,maxy)");
    const spatial = this.db.prepare("INSERT INTO ways_spatial VALUES(?,?,?,?,?)");
    const hash = createHash("sha256").update(`${NORMALIZATION_VERSION}\0${this.source.contentHash}\0${geometryHash(this.geometry)}\0`);
    const tables = {
      ways: "SELECT rowid AS spatialRow,id,refs,tags,kind,coordinates,minx,maxx,miny,maxy FROM ways ORDER BY id",
      nodes: "SELECT id,lon,lat,tags FROM nodes ORDER BY id",
      buildings: "SELECT id,lon,lat FROM relation_buildings ORDER BY id",
      unsupported: "SELECT id,disposition,reason FROM inventory ORDER BY id",
    };
    for (const [table, sql] of Object.entries(tables)) {
      hash.update(`${table}\0`);
      let count = 0;
      const indexing = table === "ways";
      if (indexing) this.db.exec("SAVEPOINT source_spatial");
      try {
        for (const row of this.db.prepare(sql).iterate() as Iterable<Record<string,unknown>>) {
          const { spatialRow, ...values } = row;
          if (indexing) spatial.run(Number(spatialRow), Number(row.minx), Number(row.maxx), Number(row.miny), Number(row.maxy));
          const record = JSON.stringify(Object.values(values));
          hash.update(`${Buffer.byteLength(record)}:${record}`);
          if (++count % CHECKPOINT_ROWS === 0) {
            await checkpoint();
            if (indexing) this.db.exec("RELEASE source_spatial; SAVEPOINT source_spatial");
          }
        }
      } catch (error) {
        if (indexing) this.db.exec("ROLLBACK TO source_spatial");
        throw error;
      } finally {
        if (indexing) this.db.exec("RELEASE source_spatial");
      }
      hash.update("\0");
      await checkpoint();
    }
    return hash.digest("hex");
  }
  async import(checkpoint: () => Promise<void>, options: { lines?: AsyncIterable<string>; batchSize?: number;
    onStage?: (stage:string)=>Promise<void> } = {}) {
    this.spatialReady = false;
    if (this.receipt(COMPLETE_KEY)) {
      await options.onStage?.("integrity-check");
      if (this.receipt(SEAL_KEY) !== await this.seal(checkpoint)) throw new Error("Staged source normalized records failed seal verification");
      this.spatialReady = true;
      return;
    }
    if (this.receipt(SEAL_KEY)) throw new Error("Staged source has a seal without a completion marker");
    const batchSize = options.batchSize ?? CHECKPOINT_ROWS;
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid import batch size");
    // Incomplete compact imports are disposable. No raw-prefix checkpoint can
    // certify an interrupted stream, so restart the filtered input atomically.
    this.db.exec(`DELETE FROM ways; DELETE FROM nodes; DELETE FROM relation_buildings; DELETE FROM inventory; DELETE FROM receipts;
      CREATE TEMP TABLE import_nodes(id TEXT PRIMARY KEY,lon REAL,lat REAL);
      CREATE TEMP TABLE source_ways(id TEXT PRIMARY KEY,refs TEXT NOT NULL);`);
    const putNode = this.db.prepare("INSERT OR REPLACE INTO import_nodes VALUES(?,?,?)");
    const getNode = this.db.prepare("SELECT * FROM import_nodes WHERE id=?");
    const putContextNode = this.db.prepare("INSERT OR REPLACE INTO nodes VALUES(?,?,?,?)");
    const putSourceWay = this.db.prepare("INSERT OR REPLACE INTO source_ways VALUES(?,?)");
    const getSourceWay = this.db.prepare("SELECT refs FROM source_ways WHERE id=?");
    const putWay = this.db.prepare("INSERT OR REPLACE INTO ways(id,refs,tags,kind,coordinates,minx,maxx,miny,maxy) VALUES(?,?,?,?,?,?,?,?,?)");
    const coordinates = (refs: string[]) => refs.map((ref): [number, number] => {
      const node = getNode.get(ref) as Node | undefined;
      if (!node) throw new Error(`Source references missing node/${ref}`);
      return [node.lon, node.lat];
    });
    const cleanupJoins = () => this.db.exec(`DROP TABLE IF EXISTS temp.import_nodes; DROP TABLE IF EXISTS temp.source_ways;`);
    let count = 0;
    this.db.exec("BEGIN");
    try {
      for await (const line of options.lines ?? filteredSourceLines(this.source.localPath, dirname(this.path), this.geometry, checkpoint, options.onStage)) {
        const fields = line.split(" "), id = fields[0]!.slice(1), type = line[0];
        const field = (prefix: string) => fields.find((value) => value.startsWith(prefix))?.slice(1) ?? "";
        if (type === "n") {
          const lon = Number(field("x")), lat = Number(field("y"));
          if (!field("x") || !field("y") || !Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`Invalid source coordinate ${id}`);
          putNode.run(id, lon, lat);
          const tags = parseOplTags(field("T"));
          if (isBuilding(tags) || osmPortalEvidenceKinds(tags).length || hasOsmNodeContext(tags)) putContextNode.run(id, lon, lat, field("T"));
        } else if (type === "w") {
          const tags = parseOplTags(field("T"));
          const refs = field("N").split(",").filter(Boolean).map((ref) => ref.slice(1));
          putSourceWay.run(id, JSON.stringify(refs));
          const kind = classifyOsmWay(tags);
          const retained = kind || isBuilding(tags) || osmPortalEvidenceKinds(tags).length;
          if (retained) {
            if (refs.length < 2) throw new Error(`Source way/${id} has fewer than two nodes`);
            const coords = coordinates(refs);
            const bounds = coords.reduce(([w,s,e,n], [x,y]) => [Math.min(w,x),Math.min(s,y),Math.max(e,x),Math.max(n,y)], [Infinity,Infinity,-Infinity,-Infinity]);
            putWay.run(id, JSON.stringify(refs), JSON.stringify(tags), kind ?? (isBuilding(tags) ? "building" : "evidence"), JSON.stringify(coords), bounds[0]!, bounds[2]!, bounds[1]!, bounds[3]!);
          }
        } else if (type === "r") {
          const tags = parseOplTags(field("T"));
          if (isBuilding(tags) && tags.type === "multipolygon") {
            try {
              const outer = field("M").split(",").filter(Boolean).filter((member) => member.startsWith("w") && ["", "outer"].includes(member.split("@")[1] ?? ""));
              const parts = outer.map((member) => {
                const wayId = member.slice(1).split("@")[0]!;
                const way = getSourceWay.get(wayId) as { refs: string } | undefined;
                if (!way) throw new UnsupportedBuildingGeometry(`Building relation/${id} references missing way/${wayId}`);
                return JSON.parse(way.refs) as string[];
              });
              const centers = outerRings(parts).map((ring) => {
                const [center] = parseBuildingCentroids(JSON.stringify({ geometry: { type: "Polygon", coordinates: [coordinates(ring)] } }));
                if (!center) throw new UnsupportedBuildingGeometry(`Invalid building relation/${id}`);
                return center;
              });
              centers.forEach((center,index) => this.db.prepare("INSERT OR REPLACE INTO relation_buildings VALUES(?,?,?)").run(`${id}:${index}`, ...center));
            } catch (error) {
              if (!(error instanceof UnsupportedBuildingGeometry)) throw error;
              this.db.prepare("INSERT OR REPLACE INTO inventory VALUES(?,'unsupported',?)").run(`relation/${id}`, `building-geometry:${error.message}`);
            }
          }
        }
        if (++count % batchSize === 0) await checkpoint();
      }
      this.db.exec("COMMIT");
      cleanupJoins();
      await options.onStage?.("integrity-check");
      const seal = await this.seal(checkpoint);
      this.db.exec("BEGIN");
      this.mark(SEAL_KEY, seal);
      this.mark(COMPLETE_KEY);
      this.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
      this.spatialReady = true;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      cleanupJoins();
    }
  }
  private *nearbyWays(area: AreaGeometry, contextDegrees=0.01): Generator<Row> {
    yield* this.nearbyWayRows(componentEnvelopes(area,contextDegrees));
  }
  private *nearbyWayRows(envelopes: readonly Envelope[]): Generator<Row> {
    if (!this.spatialReady) throw new Error("Source spatial index requires a completed verified import");
    // IN deduplicates identities when component envelopes overlap. CROSS JOIN
    // keeps spatial lookup first; exact bounds remove RTree rounding false positives.
    yield* this.db.prepare(`SELECT w.* FROM ways w WHERE w.rowid IN (
      SELECT candidate.rowid FROM json_each(?) b CROSS JOIN ways_spatial s CROSS JOIN ways candidate ON candidate.rowid=s.id
      WHERE s.minx<=json_extract(b.value,'$[0]') AND s.maxx>=json_extract(b.value,'$[1]')
        AND s.miny<=json_extract(b.value,'$[2]') AND s.maxy>=json_extract(b.value,'$[3]')
        AND candidate.minx<=json_extract(b.value,'$[0]') AND candidate.maxx>=json_extract(b.value,'$[1]')
        AND candidate.miny<=json_extract(b.value,'$[2]') AND candidate.maxy>=json_extract(b.value,'$[3]'))
      ORDER BY w.id`).iterate(JSON.stringify(envelopes)) as Iterable<Row>;
  }
  private *nearbyPoints(table: "nodes" | "relation_buildings", area: AreaGeometry): Generator<Node> {
    if (!this.spatialReady) throw new Error("Source spatial index requires a completed verified import");
    yield* this.db.prepare(`SELECT p.* FROM ${table} p WHERE p.rowid IN (
      SELECT candidate.rowid FROM json_each(?) b CROSS JOIN ${table} candidate
      WHERE candidate.lon BETWEEN json_extract(b.value,'$[1]') AND json_extract(b.value,'$[0]')
        AND candidate.lat BETWEEN json_extract(b.value,'$[3]') AND json_extract(b.value,'$[2]')
        ${table==="nodes"?"AND candidate.tags!=''":""}) ORDER BY p.id`).iterate(componentBounds(area,0.01)) as Iterable<Node>;
  }

  /** One bounded identity join per complete way, not one query per source node. */
  private nodeFlags(refs: readonly string[]): Map<string, string[]> {
    this.nodeFlagQuery ??= this.db.prepare("SELECT id,tags FROM nodes WHERE id IN (SELECT value FROM json_each(?))");
    const rows = this.nodeFlagQuery.all(JSON.stringify(refs)) as { id: string; tags: string }[];
    return new Map(rows.map(({ id, tags }) => [id, osmNodeFlags(parseOplTags(tags))]));
  }

  /** Read the regional import context once, retaining independent walking/context envelopes. */
  *context(area: AreaGeometry, walkingArea: AreaGeometry = area): Generator<CoverageContextEntry> {
    for(const row of this.nearbyPoints("nodes",area)) {
      const tags=parseOplTags(row.tags),centroid=nodeBuilding(row,tags);
      if(centroid) yield {kind:"building",centroid};
      for(const evidence of portalEvidence(`node/${row.id}`,tags,[`osm-node-${row.id}`],[[row.lon,row.lat]],this.source.id))
        yield {kind:"evidence",evidence};
    }
    for(const row of this.nearbyPoints("relation_buildings",area)) yield {kind:"building",centroid:[row.lon,row.lat]};
    const contextBounds=componentEnvelopes(area,0.01), walkingBounds=walkingArea===area ? contextBounds : componentEnvelopes(walkingArea,0.01);
    const sameBounds=walkingBounds===contextBounds || JSON.stringify(walkingBounds)===JSON.stringify(contextBounds);
    const envelopes=sameBounds ? contextBounds : [...contextBounds,...walkingBounds];
    for(const row of this.nearbyWayRows(envelopes)) {
      const context=sameBounds||intersectsEnvelopes(row,contextBounds), walking=!["building","evidence"].includes(row.kind)&&(sameBounds||intersectsEnvelopes(row,walkingBounds));
      const tags=JSON.parse(row.tags) as Record<string,string>;
      const building=context&&isBuilding(tags), evidence=context&&osmPortalEvidenceKinds(tags).length>0;
      if(!walking&&!building&&!evidence) continue;
      const coordinates=JSON.parse(row.coordinates) as [number,number][];
      const refs=walking||evidence ? JSON.parse(row.refs) as string[] : [];
      if(walking) yield {kind:"way",...walkingEntry(row,tags,refs,coordinates,this.source.id,this.nodeFlags(refs))};
      if(building) {
        const centroid=buildingCentroidOf({type:"LineString",coordinates});
        if(centroid) yield {kind:"building",centroid};
      }
      if(evidence) for(const item of portalEvidence(`way/${row.id}`,tags,refs.map(id=>`osm-node-${id}`),coordinates,this.source.id))
        yield {kind:"evidence",evidence:item};
    }
  }

  *ways(area: AreaGeometry, contextDegrees=0.01): Generator<WalkingEntry> {
    for(const row of this.nearbyWays(area,contextDegrees)) {
      if(["building","evidence"].includes(row.kind)) continue;
      const refs=JSON.parse(row.refs) as string[];
      yield walkingEntry(row,JSON.parse(row.tags),refs,JSON.parse(row.coordinates),this.source.id,this.nodeFlags(refs));
    }
  }
  *evidence(area: AreaGeometry): Generator<NormalizedPortalEvidence> {
    // OSM node tags are compact OPL strings; coordinates filter the local context first.
    for(const row of this.nearbyPoints("nodes",area))
      yield* portalEvidence(`node/${row.id}`,parseOplTags(row.tags),[`osm-node-${row.id}`],[[row.lon,row.lat]],this.source.id);
    for(const row of this.nearbyWays(area)) {
      const tags=JSON.parse(row.tags) as Record<string,string>;
      if(osmPortalEvidenceKinds(tags).length)
        yield* portalEvidence(`way/${row.id}`,tags,(JSON.parse(row.refs) as string[]).map(id=>`osm-node-${id}`),JSON.parse(row.coordinates),this.source.id);
    }
  }
  *buildings(area: AreaGeometry): Generator<readonly [number,number]> {
    for(const row of this.nearbyPoints("nodes",area)) {
      const centroid=nodeBuilding(row,parseOplTags(row.tags));
      if(centroid) yield centroid;
    }
    for(const row of this.nearbyPoints("relation_buildings",area)) yield [row.lon,row.lat];
    for(const row of this.nearbyWays(area)) {
      if(!isBuilding(JSON.parse(row.tags) as Record<string,string>)) continue;
      const centroid=buildingCentroidOf({type:"LineString",coordinates:JSON.parse(row.coordinates)});
      if(centroid) yield centroid;
    }
  }
}
