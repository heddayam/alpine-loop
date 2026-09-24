import { DatabaseSync } from "node:sqlite";
import { checkSQLiteIntegrity } from "@/lib/data/sqlite-integrity";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildingCentroidOf, parseBuildingCentroids } from "@/lib/data/osm/buildings";
import { parseOplTags } from "@/lib/data/osm/opl";
import { classifyOsmWay, needsTrailContext, osmAccessState, osmFootDirection, osmPortalEvidenceKinds, osmWayFlags } from "@/lib/data/osm/normalize";
import type { NormalizedNode, NormalizedWay, NormalizedPortalEvidence } from "@/lib/data/types";
import type { SourceSnapshot } from "@/lib/data/adapters";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { areaBounds } from "@/lib/graph/geometry";

type Row = { id: string; refs: string; tags: string; kind: string; promoted: number; coordinates: string };
type Node = { id: string; lon: number; lat: number; tags: string };
const NORMALIZED_SEAL_KEY = "normalized-seal-v1";
const UNSUPPORTED_SEAL_KEY = "unsupported-inventory-seal-v1";
const NORMALIZATION_VERSION = "source-normalization-v2";
const RAW_BATCH_PREFIX = "raw-batch-v1:";
const CHECKPOINT_ROWS = 10_000;
const RAW_COLUMNS = { nodes: "id,lon,lat,tags", source_ways: "id,refs",
  ways: "id,refs,tags,kind,coordinates,minx,maxx,miny,maxy", refs: "way,node",
  relation_buildings: "id,lon,lat" } as const;
type RawTable = keyof typeof RAW_COLUMNS;
type RawMaxima = Record<RawTable,number>;
type RawBatchSeal = { sourceHash:string; algorithmVersion:string; fromLine:number; toLine:number; legacyBaseline?:boolean;
  rows: Record<RawTable,{from:number;to:number;count:number;checksum:string}> };
type NormalizedSeal = {
  sourceHash: string; algorithmVersion: string;
  counts: { ways: number; taggedNodes: number; relationBuildings: number };
  contentHash: string;
};
async function* sourceLines(file: string): AsyncGenerator<string> {
  const child = spawn("osmium", ["cat", file, "-f", "opl"], { stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  child.stderr.on("data", (data: Buffer) => { error = (error + data.toString()).slice(-4096); });
  const ended = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`OSM import failed (${code}): ${error}`)));
  });
  void ended.catch(() => undefined);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try { yield* lines; await ended; }
  finally { child.kill(); lines.close(); await ended.catch(() => undefined); }
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

/** Source inventory precedes installation clipping. One raw record at a time, with all reference joins on disk. */
export class CoverageSourceStore {
  readonly db: DatabaseSync;
  private spatialReady = false;
  constructor(readonly path: string, readonly source: SourceSnapshot) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,lon REAL,lat REAL,tags TEXT);
      CREATE INDEX IF NOT EXISTS nodes_location ON nodes(lon,lat);
      CREATE TABLE IF NOT EXISTS source_ways(id TEXT PRIMARY KEY,refs TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relation_buildings(id TEXT PRIMARY KEY,lon REAL,lat REAL);
      CREATE INDEX IF NOT EXISTS relation_buildings_location ON relation_buildings(lon,lat);
      CREATE TABLE IF NOT EXISTS ways(id TEXT PRIMARY KEY,refs TEXT,tags TEXT,kind TEXT,promoted INTEGER DEFAULT 0,coordinates TEXT,minx REAL,maxx REAL,miny REAL,maxy REAL);
      CREATE INDEX IF NOT EXISTS ways_bounds ON ways(minx,maxx,miny,maxy);
      CREATE TABLE IF NOT EXISTS refs(way TEXT,node TEXT,PRIMARY KEY(way,node));
      CREATE INDEX IF NOT EXISTS refs_node ON refs(node,way);
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory(id TEXT PRIMARY KEY,disposition TEXT NOT NULL,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,value TEXT NOT NULL);
    `);
    const previous = this.db.prepare("SELECT value FROM meta WHERE key='source'").get() as {value:string}|undefined;
    if (previous && previous.value !== source.contentHash) { this.db.close(); throw new Error("Staged source fingerprint mismatch"); }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('source',?)").run(source.contentHash);
  }
  receipt(key: string): string | undefined { return (this.db.prepare("SELECT value FROM receipts WHERE key=?").get(key) as {value:string}|undefined)?.value; }
  mark(key: string, value = "complete") { this.db.prepare("INSERT OR REPLACE INTO receipts VALUES(?,?)").run(key,value); }
  close() { this.db.close(); }
  private rawMaxima(): RawMaxima {
    return Object.fromEntries(Object.keys(RAW_COLUMNS).map((table) => [table,
      Number((this.db.prepare(`SELECT coalesce(max(rowid),0) AS n FROM ${table}`).get() as {n:number}).n)])) as RawMaxima;
  }
  private async rawBatch(fromLine:number,toLine:number,from:RawMaxima,to:RawMaxima,checkpoint:()=>Promise<void>,legacyBaseline=false,verifying=false): Promise<RawBatchSeal> {
    const rows = {} as RawBatchSeal["rows"];
    for (const [table,columns] of Object.entries(RAW_COLUMNS) as [RawTable,string][]) {
      const hash=createHash("sha256"); let count=0;
      hash.update(`${NORMALIZATION_VERSION}\0${this.source.contentHash}\0${table}\0${fromLine}:${toLine}\0`);
      for (const row of this.db.prepare(`SELECT ${columns} FROM ${table} WHERE rowid>? AND rowid<=? ORDER BY rowid`).iterate(from[table],to[table]) as Iterable<Record<string,unknown>>) {
        const record=JSON.stringify(Object.values(row)); hash.update(`${Buffer.byteLength(record)}:`); hash.update(record); count++;
        if (count%CHECKPOINT_ROWS===0) await checkpoint();
      }
      rows[table]={from:from[table],to:to[table],count,checksum:`sha256:${hash.digest("hex")}`};
      if (verifying) await checkpoint();
    }
    return {sourceHash:this.source.contentHash,algorithmVersion:NORMALIZATION_VERSION,fromLine,toLine,
      ...(legacyBaseline?{legacyBaseline:true}:{}),rows};
  }
  private async verifyRawBatches(checkpoint:()=>Promise<void>): Promise<{committed:number;maxima:RawMaxima}> {
    const rawCounter=this.receipt("import-lines-v2"),committed=rawCounter===undefined?0:Number(rawCounter);
    if (!Number.isSafeInteger(committed)||committed<0) throw new Error("Staged source raw line counter is invalid");
    let line=0,maxima=Object.fromEntries(Object.keys(RAW_COLUMNS).map((table)=>[table,0])) as RawMaxima,seen=false;
    for (const row of this.db.prepare("SELECT key,value FROM receipts WHERE key LIKE 'raw-batch-v1:%' ORDER BY CAST(substr(key,14) AS INTEGER)").iterate() as Iterable<{key:string;value:string}>) {
      let seal:RawBatchSeal;
      try {seal=JSON.parse(row.value) as RawBatchSeal;} catch {throw new Error("Staged source raw batch receipt is malformed");}
      if (seal.fromLine!==line||!Number.isSafeInteger(seal.toLine)||seal.toLine<=line||seal.toLine>committed||
        row.key!==`${RAW_BATCH_PREFIX}${seal.toLine}`||seal.sourceHash!==this.source.contentHash||seal.algorithmVersion!==NORMALIZATION_VERSION)
        throw new Error("Staged source raw batch line receipt failed verification");
      const to=Object.fromEntries(Object.keys(RAW_COLUMNS).map((table)=>[table,seal.rows?.[table as RawTable]?.to])) as RawMaxima;
      if (Object.values(to).some((value)=>!Number.isSafeInteger(value)||value<0)) throw new Error("Staged source raw batch row range is invalid");
      const expected=await this.rawBatch(line,seal.toLine,maxima,to,checkpoint,Boolean(seal.legacyBaseline),true);
      if (JSON.stringify(seal)!==JSON.stringify(expected)) throw new Error("Staged source raw batch records failed checksum verification");
      line=seal.toLine;maxima=to;seen=true;
      await checkpoint();
    }
    let baseline:RawBatchSeal|undefined;
    if (!seen&&committed>0) {
      // Old in-progress caches have only a line counter. Seal the existing
      // committed prefix once; its history before this baseline is unverifiable.
      maxima=this.rawMaxima();baseline=await this.rawBatch(0,committed,
        Object.fromEntries(Object.keys(RAW_COLUMNS).map((table)=>[table,0])) as RawMaxima,maxima,checkpoint,true,true);
      line=committed;
    }
    if (line!==committed||Object.entries(this.rawMaxima()).some(([table,max])=>max!==maxima[table as RawTable]))
      throw new Error("Staged source raw batch counter or row range failed verification");
    if (committed>0) await checkpoint();
    if (baseline) this.mark(`${RAW_BATCH_PREFIX}${committed}`,JSON.stringify(baseline));
    return {committed,maxima};
  }
  private async normalizedSeal(checkpoint:()=>Promise<void>): Promise<NormalizedSeal> {
    await checkpoint();
    await checkSQLiteIntegrity(this.path, this.db, checkpoint);
    await checkpoint();
    // Derived spatial state is rebuilt with the mandatory seal scan. A paused
    // or corrupt cache cannot leave a trusted but incomplete persisted index.
    this.db.exec("DROP TABLE IF EXISTS temp.ways_spatial; CREATE VIRTUAL TABLE temp.ways_spatial USING rtree(id,minx,maxx,miny,maxy)");
    const spatial = this.db.prepare("INSERT INTO ways_spatial VALUES(?,?,?,?,?)");
    const hash = createHash("sha256");
    hash.update(`${NORMALIZATION_VERSION}\0${this.source.contentHash}\0`);
    const counts = { ways: 0, taggedNodes: 0, relationBuildings: 0 };
    const scan = async (kind: keyof typeof counts, sql: string) => {
      hash.update(`${kind}\0`);
      for (const row of this.db.prepare(sql).iterate() as Iterable<Record<string,unknown>>) {
        const { spatialRow, ...values } = row;
        if (kind === "ways") spatial.run(Number(spatialRow), Number(row.minx), Number(row.maxx), Number(row.miny), Number(row.maxy));
        const record = JSON.stringify(Object.values(values));
        hash.update(`${Buffer.byteLength(record)}:`);
        hash.update(record);
        counts[kind]++;
        if (counts[kind]%CHECKPOINT_ROWS===0) await checkpoint();
      }
      hash.update("\0");
      await checkpoint();
    };
    // These are the immutable rows read by ways(), evidence(), and buildings().
    // Metrics and inventory dispositions are intentionally mutable and excluded.
    await scan("ways", "SELECT rowid AS spatialRow,id,refs,tags,kind,promoted,coordinates,minx,maxx,miny,maxy FROM ways ORDER BY id");
    await scan("taggedNodes", "SELECT id,lon,lat,tags FROM nodes WHERE tags!='' ORDER BY id");
    await scan("relationBuildings", "SELECT id,lon,lat FROM relation_buildings ORDER BY id");
    return { sourceHash: this.source.contentHash, algorithmVersion: NORMALIZATION_VERSION, counts, contentHash: `sha256:${hash.digest("hex")}` };
  }
  private async unsupportedSeal(checkpoint:()=>Promise<void>): Promise<string> {
    const hash=createHash("sha256"); let count=0;
    hash.update(`${NORMALIZATION_VERSION}\0${this.source.contentHash}\0unsupported-inventory\0`);
    for (const row of this.db.prepare("SELECT id,reason FROM inventory WHERE disposition='unsupported' ORDER BY id").iterate() as Iterable<Record<string,unknown>>) {
      const record=JSON.stringify(Object.values(row)); hash.update(`${Buffer.byteLength(record)}:`); hash.update(record);
      if (++count%CHECKPOINT_ROWS===0) await checkpoint();
    }
    await checkpoint();
    return JSON.stringify({sourceHash:this.source.contentHash,algorithmVersion:NORMALIZATION_VERSION,count,contentHash:`sha256:${hash.digest("hex")}`});
  }
  private async verifyCompletedImport(checkpoint:()=>Promise<void>): Promise<void> {
    const expected = await this.normalizedSeal(checkpoint);
    const saved = this.receipt(NORMALIZED_SEAL_KEY);
    if (saved) {
      let actual: NormalizedSeal;
      try { actual = JSON.parse(saved) as NormalizedSeal; }
      catch { throw new Error("Staged source normalized seal is malformed"); }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Staged source normalized records failed seal verification");
    }
    const unsupported=await this.unsupportedSeal(checkpoint),savedUnsupported=this.receipt(UNSUPPORTED_SEAL_KEY);
    if (savedUnsupported && savedUnsupported!==unsupported) throw new Error("Staged source unsupported inventory failed seal verification");
    if (!saved || !savedUnsupported) {
      // Older completed caches predate these seals. Certify both baselines
      // atomically only after every verification scan and checkpoint succeeds.
      await checkpoint();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!saved) this.mark(NORMALIZED_SEAL_KEY,JSON.stringify(expected));
        if (!savedUnsupported) this.mark(UNSUPPORTED_SEAL_KEY,unsupported);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  private async promoteContextualWays(checkpoint:()=>Promise<void>): Promise<void> {
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS promotion_frontier(node TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS promotion_found(way TEXT PRIMARY KEY) WITHOUT ROWID;
      DELETE FROM promotion_frontier; DELETE FROM promotion_found;
      UPDATE ways SET promoted=1 WHERE kind='trail' AND promoted=0`);
    // Seed from every already promoted way so a pause after any wave can resume.
    const maxRow=Number((this.db.prepare("SELECT coalesce(max(rowid),0) AS n FROM ways").get() as {n:number}).n);
    const seed=this.db.prepare(`INSERT OR IGNORE INTO promotion_frontier
      SELECT r.node FROM ways w JOIN refs r ON r.way=w.id WHERE w.rowid>? AND w.rowid<=? AND w.promoted=1`);
    for(let from=0;from<maxRow;from+=CHECKPOINT_ROWS) {
      seed.run(from,from+CHECKPOINT_ROWS);
      await checkpoint();
    }
    const page=this.db.prepare("SELECT node FROM promotion_frontier WHERE node>? ORDER BY node LIMIT ?");
    const adjacent=this.db.prepare(`INSERT OR IGNORE INTO promotion_found
      SELECT b.way FROM promotion_frontier f CROSS JOIN refs b INDEXED BY refs_node ON b.node=f.node
      JOIN ways w ON w.id=b.way WHERE f.node>? AND f.node<=? AND w.kind='ambiguous' AND w.promoted=0`);
    const promote=this.db.prepare("UPDATE ways SET promoted=1 WHERE id IN (SELECT way FROM promotion_found)");
    const foundPage=this.db.prepare("SELECT way FROM promotion_found WHERE way>? ORDER BY way LIMIT ?");
    const next=this.db.prepare(`INSERT OR IGNORE INTO promotion_frontier
      SELECT r.node FROM promotion_found p CROSS JOIN refs r ON r.way=p.way WHERE p.way>? AND p.way<=?`);
    for (;;) {
      this.db.exec("DELETE FROM promotion_found");
      let cursor="",added=0;
      for (;;) {
        const rows=page.all(cursor,CHECKPOINT_ROWS) as {node:string}[];
        if (!rows.length) break;
        const end=rows.at(-1)!.node;
        added+=Number(adjacent.run(cursor,end).changes);
        cursor=end;
        await checkpoint();
      }
      if (!added) break;
      promote.run();
      await checkpoint();
      this.db.exec("DELETE FROM promotion_frontier");
      cursor="";
      for (;;) {
        const rows=foundPage.all(cursor,CHECKPOINT_ROWS) as {way:string}[];
        if (!rows.length) break;
        const end=rows.at(-1)!.way;
        next.run(cursor,end);
        cursor=end;
        await checkpoint();
      }
    }
    this.db.exec("DELETE FROM promotion_frontier; DELETE FROM promotion_found");
  }
  async import(checkpoint: () => Promise<void>, options: { lines?: AsyncIterable<string>; batchSize?: number;
    onStage?: (stage:"checkpoint-verification"|"context-promotion"|"integrity-check")=>Promise<void> } = {}) {
    this.spatialReady = false;
    if (this.receipt("import-v2")) { await options.onStage?.("integrity-check"); await this.verifyCompletedImport(checkpoint); this.spatialReady = true; return; }
    if (this.receipt("import-lines-v2")) await options.onStage?.("checkpoint-verification");
    const verified=await this.verifyRawBatches(checkpoint);
    if (!this.receipt("raw-import-v2")) {
      const putNode = this.db.prepare("INSERT OR REPLACE INTO nodes VALUES(?,?,?,?)");
      const getNode = this.db.prepare("SELECT * FROM nodes WHERE id=?");
      const putSourceWay = this.db.prepare("INSERT OR REPLACE INTO source_ways VALUES(?,?)");
      const getSourceWay = this.db.prepare("SELECT refs FROM source_ways WHERE id=?");
      const putWay = this.db.prepare("INSERT OR REPLACE INTO ways(id,refs,tags,kind,coordinates,minx,maxx,miny,maxy) VALUES(?,?,?,?,?,?,?,?,?)");
      const putRef = this.db.prepare("INSERT OR IGNORE INTO refs VALUES(?,?)");
      const inventory = this.db.prepare("INSERT OR REPLACE INTO inventory VALUES(?,?,?)");
      const committed = verified.committed;
      let sealedLine=committed, startRows=verified.maxima;
      const batchSize = options.batchSize ?? 10_000;
      if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid import batch size");
      const coordinates = (refs: string[]) => refs.map((ref): [number, number] => {
        const node = getNode.get(ref) as Node | undefined;
        if (!node) throw new Error(`Source references missing node/${ref}`);
        return [node.lon, node.lat];
      });
      let count = 0;
      this.db.exec("BEGIN");
      try {
        for await (const line of options.lines ?? sourceLines(this.source.localPath)) {
          if (++count <= committed) continue;
          const fields = line.split(" "), id = fields[0]!.slice(1), type = line[0];
          const field = (prefix: string) => fields.find((value) => value.startsWith(prefix))?.slice(1) ?? "";
          if (type === "n") {
            const lon = Number(field("x")), lat = Number(field("y"));
            if (!field("x") || !field("y") || !Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`Invalid source coordinate ${id}`);
            putNode.run(id, lon, lat, field("T"));
          } else if (type === "w") {
            const tags = parseOplTags(field("T"));
            const refs = field("N").split(",").filter(Boolean).map((ref) => ref.slice(1));
            putSourceWay.run(id, JSON.stringify(refs));
            const kind = classifyOsmWay(tags), evidence = osmPortalEvidenceKinds(tags);
            const retained = kind || tags.building || evidence.length;
            inventory.run(`way/${id}`, kind === "trail" ? "candidate" : retained ? "context" : "excluded",
              kind === "trail" ? `access:${osmAccessState(tags)}` : needsTrailContext(tags) ? "unresolved-footway" : kind ?? (tags.building ? "building" : evidence.length ? "portal-evidence" : "non-hiking-way"));
            if (retained) {
              if (refs.length < 2) throw new Error(`Source way/${id} has fewer than two nodes`);
              const coords = coordinates(refs);
              const bounds = coords.reduce(([w,s,e,n], [x,y]) => [Math.min(w,x),Math.min(s,y),Math.max(e,x),Math.max(n,y)], [Infinity,Infinity,-Infinity,-Infinity]);
              putWay.run(id, JSON.stringify(refs), JSON.stringify(tags), needsTrailContext(tags) ? "ambiguous" : kind ?? (tags.building ? "building" : "evidence"), JSON.stringify(coords), bounds[0]!, bounds[2]!, bounds[1]!, bounds[3]!);
              if (kind) for (const ref of refs) putRef.run(id, ref);
            }
          } else if (type === "r") {
            const tags = parseOplTags(field("T"));
            if (tags.building && tags.building !== "no" && tags.type === "multipolygon") {
              try {
                const outer = field("M").split(",").filter(Boolean).filter((member) => member.startsWith("w") && ["", "outer"].includes(member.split("@")[1] ?? ""));
                const parts = outer.map((member) => {
                  const wayId = member.slice(1).split("@")[0]!;
                  const way = getSourceWay.get(wayId) as { refs: string } | undefined;
                  if (!way) throw new UnsupportedBuildingGeometry(`Building relation/${id} references missing way/${wayId}`);
                  return JSON.parse(way.refs) as string[];
                });
                const rings = outerRings(parts);
                // Match the existing building normalizer: each polygon contributes its outer-ring centroid.
                const centers = rings.map((ring) => {
                  const [center] = parseBuildingCentroids(JSON.stringify({ geometry: { type: "Polygon", coordinates: [coordinates(ring)] } }));
                  if (!center) throw new UnsupportedBuildingGeometry(`Invalid building relation/${id}`);
                  return center;
                });
                centers.forEach((center,index) => this.db.prepare("INSERT OR REPLACE INTO relation_buildings VALUES(?,?,?)").run(`${id}:${index}`, ...center));
                inventory.run(`relation/${id}`, "context", "building");
              } catch (error) {
                if (!(error instanceof UnsupportedBuildingGeometry)) throw error;
                inventory.run(`relation/${id}`, "unsupported", `building-geometry:${error.message}`);
              }
            } else if (tags.name && (tags.boundary || tags.protect_class || tags.leisure === "nature_reserve" || tags.leisure === "park")) {
              inventory.run(`relation/${id}`, "excluded", "named-area-geometry-not-imported");
            }
          }
          if (count % batchSize === 0) {
            const endRows=this.rawMaxima();
            this.mark(`${RAW_BATCH_PREFIX}${count}`,JSON.stringify(await this.rawBatch(sealedLine,count,startRows,endRows,checkpoint)));
            this.mark("import-lines-v2", String(count));
            this.db.exec("COMMIT");
            sealedLine=count;startRows=endRows;
            await checkpoint();
            this.db.exec("BEGIN");
          }
        }
        if (count < committed) throw new Error("Source stream is shorter than its committed checkpoint");
        if (count>sealedLine) {
          const endRows=this.rawMaxima();
          this.mark(`${RAW_BATCH_PREFIX}${count}`,JSON.stringify(await this.rawBatch(sealedLine,count,startRows,endRows,checkpoint)));
        }
        this.mark("import-lines-v2", String(count));
        this.mark("raw-import-v2");
        this.db.exec("COMMIT");
        await checkpoint();
      } catch (cause) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw cause; }
    }
    await options.onStage?.("context-promotion");
    await this.promoteContextualWays(checkpoint);
    this.db.exec(`UPDATE inventory SET disposition='candidate',reason='connected-trail-footway'
      WHERE id IN (SELECT 'way/'||id FROM ways WHERE kind='ambiguous' AND promoted=1)`);
    await options.onStage?.("integrity-check");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const normalized=await this.normalizedSeal(checkpoint);
      const unsupported=await this.unsupportedSeal(checkpoint);
      await checkpoint();
      this.mark(NORMALIZED_SEAL_KEY, JSON.stringify(normalized));
      this.mark(UNSUPPORTED_SEAL_KEY, unsupported);
      this.mark("import-v2");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.spatialReady = true;
  }
  private *nearbyWays(area: AreaGeometry, contextDegrees=0.01): Generator<Row> {
    if (!this.spatialReady) throw new Error("Source spatial index requires a completed verified import");
    const [w,s,e,n]=areaBounds(area), bounds=[e+contextDegrees,w-contextDegrees,n+contextDegrees,s-contextDegrees];
    // CROSS JOIN keeps the spatial lookup first; exact bounds remove RTree
    // float32 rounding false positives without changing source-boundary behavior.
    yield* this.db.prepare(`SELECT w.* FROM ways_spatial s CROSS JOIN ways w ON w.rowid=s.id
      WHERE s.minx<=? AND s.maxx>=? AND s.miny<=? AND s.maxy>=?
        AND w.minx<=? AND w.maxx>=? AND w.miny<=? AND w.maxy>=? ORDER BY w.id`).iterate(...bounds,...bounds) as Iterable<Row>;
  }
  *ways(area: AreaGeometry, contextDegrees=0.01): Generator<{way:NormalizedWay; nodes:NormalizedNode[]}> {
    for(const raw of this.nearbyWays(area,contextDegrees)) {
      const row=raw as Row;
      if(["building","evidence"].includes(row.kind)) continue;
      const tags=JSON.parse(row.tags) as Record<string,string>,direction=osmFootDirection(tags);
      let refs=JSON.parse(row.refs) as string[], coords=JSON.parse(row.coordinates) as [number,number][];
      if(direction==="reverse") {refs=refs.reverse();coords=coords.reverse();}
      const nodes=refs.map((id,index)=>({id:`osm-node-${id}`,externalId:`node/${id}`,lon:coords[index]![0],lat:coords[index]![1],elevationM:null,flags:[],sourceRefs:[this.source.id]}));
      yield {nodes,way:{id:`osm-way-${row.id}`,externalId:`way/${row.id}`,nodeIds:nodes.map((node)=>node.id),coordinates:coords,name:tags.name??null,accessState:osmAccessState(tags),bidirectional:direction==="both",edgeClass:row.promoted?"trail":row.kind==="ambiguous"?"sidewalk":row.kind as NormalizedWay["edgeClass"],sourceRefs:[this.source.id],flags:osmWayFlags(tags,`way/${row.id}`,direction)}};
    }
  }
  *evidence(area: AreaGeometry): Generator<NormalizedPortalEvidence> {
    const [w,s,e,n]=areaBounds(area);
    // OSM node tags are compact OPL strings; coordinates filter the local context first.
    for(const raw of this.db.prepare("SELECT * FROM nodes WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND tags!=''").iterate(w-.01,e+.01,s-.01,n+.01)) {
      const row=raw as Node,tags=parseOplTags(row.tags);
      for(const kind of osmPortalEvidenceKinds(tags)) yield {id:`osm-evidence-${kind}-node-${row.id}`,externalId:`node/${row.id}`,kind,name:tags.name??null,nodeIds:[`osm-node-${row.id}`],coordinates:[[row.lon,row.lat]],accessState:osmAccessState(tags),sourceRefs:[this.source.id]};
    }
    for(const raw of this.nearbyWays(area)) {
      const row=raw as Row,tags=JSON.parse(row.tags) as Record<string,string>;
      for(const kind of osmPortalEvidenceKinds(tags)) yield {id:`osm-evidence-${kind}-way-${row.id}`,externalId:`way/${row.id}`,kind,name:tags.name??null,nodeIds:(JSON.parse(row.refs) as string[]).map((id)=>`osm-node-${id}`),coordinates:JSON.parse(row.coordinates),accessState:osmAccessState(tags),sourceRefs:[this.source.id]};
    }
  }
  *buildings(area: AreaGeometry): Generator<readonly [number,number]> {
    const [w,s,e,n]=areaBounds(area);
    for (const raw of this.db.prepare("SELECT lon,lat,tags FROM nodes WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND tags!=''").iterate(w-.01,e+.01,s-.01,n+.01)) {
      if (!parseOplTags(String(raw.tags)).building) continue;
      const centroid = buildingCentroidOf({ type: "Point", coordinates: [Number(raw.lon), Number(raw.lat)] });
      if (centroid) yield centroid;
    }
    for (const row of this.db.prepare("SELECT lon,lat FROM relation_buildings WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?").iterate(w-.01,e+.01,s-.01,n+.01)) yield [Number(row.lon), Number(row.lat)];
    for(const raw of this.nearbyWays(area)) {
      if(!JSON.parse(String(raw.tags)).building) continue;
      const points=JSON.parse(String(raw.coordinates)) as [number,number][];
      const centroid = buildingCentroidOf({ type: "LineString", coordinates: points });
      if (centroid) yield centroid;
    }
  }
}
