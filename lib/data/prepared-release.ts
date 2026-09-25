import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import { areaBounds, coordinateIsInsideArea } from "@/lib/graph/geometry";
import { contentId, installationUnits } from "@/lib/coverage/geometry";
import { auditPreparedGraph } from "./prepared-audit";
import { createPreparedSchema } from "./sqlite-writer";
import { writeJsonAtomically } from "./source-cache";
import type { Coordinate } from "./types";

type Geometry = DataRelease["geometry"];
export type PreparedReleaseOptions = Pick<DataRelease,"geometry"|"sources"|"regions"|"builtAt"|"compilerVersion"|"metricAlgorithmVersion"> & {
  databasePath: string; outputRoot: string; limitations?: string[]; checkpoint?: () => Promise<void>;
};
export function preparedReleaseId(input: Pick<PreparedReleaseOptions,"geometry"|"sources"|"regions"|"builtAt"|"compilerVersion"|"metricAlgorithmVersion"|"limitations">): string {
  return `release-${contentId({ geometry:input.geometry, sources:input.sources, regions:input.regions, compilerVersion:input.compilerVersion, metricAlgorithmVersion:input.metricAlgorithmVersion, builtAt:input.builtAt, limitations:input.limitations ?? [] }).slice(0,32)}`;
}
/** Inclusive segment intersection: boundary contacts belong to both adjacent sections. */
function touches(line: Coordinate[], area: Geometry): boolean {
  if (line.some(point => coordinateIsInsideArea(point,area))) return true;
  const rings = area.type === "Polygon" ? area.coordinates : area.coordinates.flat();
  const cross=(a:Coordinate,b:Coordinate,c:Coordinate)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=1;i<line.length;i++) for(const ring of rings) for(let j=1;j<ring.length;j++) {
    const a=line[i-1]!,b=line[i]!,c=ring[j-1]!,d=ring[j]!;
    if(Math.max(a[0],b[0]) < Math.min(c[0],d[0]) || Math.max(c[0],d[0]) < Math.min(a[0],b[0]) || Math.max(a[1],b[1]) < Math.min(c[1],d[1]) || Math.max(c[1],d[1]) < Math.min(a[1],b[1])) continue;
    if(cross(a,b,c)*cross(a,b,d)<=0 && cross(c,d,a)*cross(c,d,b)<=0) return true;
  }
  return false;
}

/** Partition a complete, audited graph without renumbering or trimming source segments. */
export async function exportPreparedRelease(options: PreparedReleaseOptions): Promise<DataRelease> {
  const checkpoint=options.checkpoint ?? (async()=>{}), id=preparedReleaseId(options);
  await mkdir(path.join(options.outputRoot,"objects"),{recursive:true});
  const temp=await mkdtemp(path.join(options.outputRoot,".export-"));
  const input=new DatabaseSync(options.databasePath,{readOnly:true});
  const release:DataRelease={schemaVersion:1,graphSchemaVersion:"7",id,builtAt:options.builtAt,compilerVersion:options.compilerVersion,metricAlgorithmVersion:options.metricAlgorithmVersion,sources:options.sources,regions:options.regions,geometry:options.geometry,limitations:options.limitations??[],sections:[],artifacts:[]};
  try {
    const schema=input.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get();
    if(schema?.value!=="7") throw new Error("Release export requires a complete schema-7 graph");
    input.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
    await auditPreparedGraph(input,release,checkpoint);
    input.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; CREATE TEMP TABLE accounted(id TEXT PRIMARY KEY) STRICT");
    let work=0;
    for(const unit of installationUnits(options.geometry)) {
      await checkpoint();
      const sectionId=unit.id.split("-").slice(0,3).join("-");
      const file=path.join(temp,"section.sqlite"), db=new DatabaseSync(file);
      try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384");
        createPreparedSchema(db);
        const writers=new Map<string,StatementSync>();
        const insert=(table:string,row:Record<string,SQLInputValue>)=>{
          let statement=writers.get(table);
          if(!statement) {statement=db.prepare(`INSERT OR IGNORE INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`);writers.set(table,statement);}
          statement.run(...Object.values(row));
        };
        const nodeById=input.prepare("SELECT * FROM nodes WHERE id=?"), physicalById=input.prepare("SELECT * FROM physical_edges WHERE physical_edge_key=?"), spatialById=input.prepare("SELECT * FROM edge_spatial WHERE row_id=?");
        const account=input.prepare("INSERT OR IGNORE INTO accounted VALUES (?)");
        const [w,s,e,n]=areaBounds(unit.geometry);
        db.exec("BEGIN");
        for(const row of input.prepare(`SELECT e.* FROM edges e JOIN edge_spatial s ON s.row_id=e.edge_key WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=? ORDER BY e.edge_key`).iterate(w,e,s,n)) {
          if(++work%1000===0) await checkpoint();
          if(!touches(JSON.parse(String(row.geometry)) as Coordinate[],unit.geometry)) continue;
          for(const nodeId of [row.from_node,row.to_node]) {
            const node=nodeById.get(nodeId as string)!;
            insert("nodes",node); insert("node_spatial",{row_id:node.node_key,min_lon:node.lon,max_lon:node.lon,min_lat:node.lat,max_lat:node.lat});
          }
          insert("physical_edges",physicalById.get(row.physical_edge_key as number)!);
          insert("edges",row); insert("edge_spatial",spatialById.get(row.edge_key as number)!);
          account.run(row.id as string);
        }
        for(const row of input.prepare(`SELECT a.*,n.lon,n.lat FROM access_points a JOIN nodes n ON n.id=a.node_id JOIN node_spatial s ON s.row_id=n.node_key WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=? ORDER BY a.id`).iterate(w,e,s,n)) {
          if(++work%1000===0) await checkpoint();
          if(!coordinateIsInsideArea([Number(row.lon),Number(row.lat)],unit.geometry)) continue;
          if(!db.prepare("SELECT 1 FROM nodes WHERE id=?").get(row.node_id as string)) continue;
          const {lon,lat,...access}=row; void lon; void lat; insert("access_points",access);
        }
        for(const source of input.prepare("SELECT * FROM sources ORDER BY id").iterate()) insert("sources",source);
        for(const [key,value] of Object.entries({schemaVersion:"7",sectionId,releaseId:id,dataVersion:id,builtAt:options.builtAt,compilerVersion:options.compilerVersion,metricAlgorithmVersion:options.metricAlgorithmVersion})) insert("metadata",{key,value});
        db.exec("COMMIT");
        if(db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Section endpoint references are incomplete");
        if(db.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok") throw new Error("Section integrity check failed");
      } finally {db.close();}
      const hash=createHash("sha256");
      for await(const bytes of createReadStream(file)) hash.update(bytes);
      const digest=hash.digest("hex"), relative=`objects/${digest}.sqlite.gz`, compressed=path.join(temp,"section.gz");
      await pipeline(createReadStream(file),createGzip({level:6}),createWriteStream(compressed));
      const artifact={id:digest,path:relative,bytes:(await stat(file)).size,compressedBytes:(await stat(compressed)).size,geometry:unit.geometry};
      await rename(compressed,path.join(options.outputRoot,relative)); await rm(file);
      release.sections.push({id:sectionId,geometry:unit.geometry,artifactIds:[digest]});
      release.artifacts.push(artifact);
    }
    if(input.prepare("SELECT id FROM edges WHERE id NOT IN (SELECT id FROM accounted) LIMIT 1").get()) throw new Error("Release export lost source graph edges");
    dataReleaseSchema.parse(release);
    await writeJsonAtomically(path.join(options.outputRoot,"release.json"),release);
    return release;
  } finally {input.close();await rm(temp,{recursive:true,force:true});}
}

/** Verify transport hashes, uncompressed identities, SQLite contents, and visible inventory. */
export async function inspectPreparedRelease(manifestPath:string,checkpoint:()=>Promise<void>=async()=>{}) {
  const {readFile}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {createGunzip}=await import("node:zlib");
  const {Transform}=await import("node:stream");
  const release=dataReleaseSchema.parse(JSON.parse(await readFile(manifestPath,"utf8")));
  const temporary=await mkdtemp(path.join(tmpdir(),"alpine-release-inspect-"));
  const artifacts=[];
  try {
    for(const artifact of release.artifacts) {
      await checkpoint();
      const compressed=path.join(path.dirname(manifestPath),artifact.path), file=path.join(temporary,"artifact.sqlite");
      if((await stat(compressed)).size!==artifact.compressedBytes) throw new Error(`Compressed artifact size differs: ${artifact.id}`);
      const hash=createHash("sha256");let bytes=0;
      const verify=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);if(bytes>artifact.bytes) done(new Error("Artifact exceeds declared size"));else done(null,chunk);}});
      await pipeline(createReadStream(compressed),createGunzip(),verify,createWriteStream(file));
      if(bytes!==artifact.bytes||hash.digest("hex")!==artifact.id) throw new Error(`Artifact checksum/size differs: ${artifact.id}`);
      const db=new DatabaseSync(file,{readOnly:true});
      try {
        db.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
        await auditPreparedGraph(db,release,checkpoint);
        artifacts.push({id:artifact.id,nodes:Number(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n),directedEdges:Number(db.prepare("SELECT count(*) AS n FROM edges").get()!.n),accessPoints:Number(db.prepare("SELECT count(*) AS n FROM access_points").get()!.n)});
      } finally {db.close();await rm(file);}
    }
    return {id:release.id,verified:true,sections:release.sections.length,artifacts,rawBytes:release.artifacts.reduce((sum,item)=>sum+item.bytes,0),compressedBytes:release.artifacts.reduce((sum,item)=>sum+item.compressedBytes,0)};
  } finally {await rm(temporary,{recursive:true,force:true});}
}
