import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import type { AreaGeometry } from "./area-geometry";
import { contentId } from "@/lib/coverage/geometry";
import { auditPreparedGraph } from "./prepared-audit";
import { writeJsonAtomically } from "./source-cache";

export type PreparedReleaseOptions = Pick<DataRelease,"geometry"|"sources"|"regions"|"builtAt"|"compilerVersion"|"metricAlgorithmVersion"> & {
  databasePath: string; outputRoot: string; limitations?: string[]; checkpoint?: () => Promise<void>;
  area: { id: string; inputFingerprint: string; startGeometry: AreaGeometry; maximumRouteMiles: number; bufferMiles: number };
  publish?: boolean;
};
export function preparedReleaseId(input: Pick<PreparedReleaseOptions,"geometry"|"sources"|"regions"|"builtAt"|"compilerVersion"|"metricAlgorithmVersion"|"limitations"|"area">): string {
  return `area-${contentId({ area:input.area, geometry:input.geometry, sources:input.sources, regions:input.regions, compilerVersion:input.compilerVersion, metricAlgorithmVersion:input.metricAlgorithmVersion, builtAt:input.builtAt, limitations:input.limitations ?? [] }).slice(0,32)}`;
}

/** Export one bounded prepared area, without clipping, repartitioning or renumbering. */
export async function exportPreparedRelease(options: PreparedReleaseOptions): Promise<DataRelease> {
  const checkpoint=options.checkpoint ?? (async()=>{}), id=preparedReleaseId(options);
  await mkdir(path.join(options.outputRoot,"objects"),{recursive:true});
  const temporary=await mkdtemp(path.join(options.outputRoot,".export-"));
  const input=new DatabaseSync(options.databasePath,{readOnly:true});
  try {
    input.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
    // The preparation writer must be closed before export; hashing the database file
    // cannot include pending WAL pages. Catalog validation also audits the exact bytes.
    if(input.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete") throw new Error("Area export requires a finalized DELETE-journal database");
    await auditPreparedGraph(input,{id,geometry:options.geometry,sources:options.sources},checkpoint);
    const hash=createHash("sha256"); let bytes=0;
    const compressed=path.join(temporary,"area.gz");
    const measure=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);checkpoint().then(()=>done(null,chunk),done);}});
    await pipeline(createReadStream(options.databasePath),measure,createGzip({level:6}),createWriteStream(compressed));
    const digest=hash.digest("hex"), relative=`objects/${digest}.sqlite.gz`;
    const artifact={id:digest,path:relative,bytes,compressedBytes:(await stat(compressed)).size,geometry:options.geometry,graphId:id,startGeometry:options.area.startGeometry};
    const release=dataReleaseSchema.parse({schemaVersion:1,graphSchemaVersion:"7",partitioning:"local-areas",id,builtAt:options.builtAt,compilerVersion:options.compilerVersion,metricAlgorithmVersion:options.metricAlgorithmVersion,sources:options.sources,regions:options.regions,geometry:options.geometry,limitations:options.limitations??[],sections:[{id:options.area.id,geometry:options.area.startGeometry,artifactIds:[digest],area:{maximumRouteMiles:options.area.maximumRouteMiles,bufferMiles:options.area.bufferMiles}}],artifacts:[artifact]});
    await checkpoint();
    await rename(compressed,path.join(options.outputRoot,relative));
    if(options.publish!==false) await publishPreparedCatalog(release,options.outputRoot,checkpoint);
    return release;
  } finally {input.close();await rm(temporary,{recursive:true,force:true});}
}

/** Validate every immutable object, including reused objects, before one atomic activation. */
export async function publishPreparedCatalog(release:DataRelease,outputRoot:string,checkpoint:()=>Promise<void>=async()=>{}):Promise<void> {
  const candidate=dataReleaseSchema.parse(release);
  await auditCatalog(candidate,outputRoot,checkpoint);
  await checkpoint();
  await writeJsonAtomically(path.join(outputRoot,"release.json"),candidate);
}

/** Inspect and publication share the same streamed transport and graph integrity checks. */
export async function inspectPreparedRelease(manifestPath:string,checkpoint:()=>Promise<void>=async()=>{}) {
  const release=dataReleaseSchema.parse(JSON.parse(await readFile(manifestPath,"utf8")));
  return auditCatalog(release,path.dirname(manifestPath),checkpoint);
}

async function auditCatalog(release:DataRelease,outputRoot:string,checkpoint:()=>Promise<void>) {
  const temporary=await mkdtemp(path.join(tmpdir(),"alpine-release-audit-"));
  const identities=new DatabaseSync(path.join(temporary,"identities.sqlite"));
  const artifacts=[];
  try {
    identities.exec(`PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;
      CREATE TABLE identities(kind TEXT NOT NULL,numeric_key INTEGER NOT NULL,source_id TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(kind,numeric_key),UNIQUE(kind,source_id)) STRICT;
      CREATE TABLE accesses(source_id TEXT PRIMARY KEY,signature TEXT NOT NULL) STRICT;`);
    const existing=identities.prepare("SELECT * FROM identities WHERE kind=? AND (numeric_key=? OR source_id=?)");
    const insert=identities.prepare("INSERT INTO identities VALUES (?,?,?,?)");
    const accessById=identities.prepare("SELECT signature FROM accesses WHERE source_id=?");
    const insertAccess=identities.prepare("INSERT INTO accesses VALUES (?,?)");
    let work=0;
    for(const artifact of release.artifacts) {
      await checkpoint();
      const compressed=path.join(outputRoot,artifact.path), file=path.join(temporary,"artifact.sqlite");
      if((await stat(compressed)).size!==artifact.compressedBytes) throw new Error(`Compressed artifact size differs: ${artifact.id}`);
      const hash=createHash("sha256");let bytes=0;
      const verify=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);if(bytes>artifact.bytes) done(new Error("Artifact exceeds declared size"));else checkpoint().then(()=>done(null,chunk),done);}});
      await pipeline(createReadStream(compressed),createGunzip(),verify,createWriteStream(file));
      if(bytes!==artifact.bytes||hash.digest("hex")!==artifact.id) throw new Error(`Artifact checksum/size differs: ${artifact.id}`);
      const db=new DatabaseSync(file,{readOnly:true});
      try {
        db.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
        await auditPreparedGraph(db,{id:artifact.graphId??release.id,geometry:release.partitioning==="connected-networks"||release.partitioning==="local-areas"?artifact.geometry:release.geometry,sources:release.sources},checkpoint,true);
        if (release.partitioning !== "local-areas") {
        identities.exec("BEGIN");
        for(const [table,key,id] of [["nodes","node_key","id"],["edges","edge_key","id"],["physical_edges","physical_edge_key","stable_physical_id"]]) {
          for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) {
            if(++work%1000===0) await checkpoint();
            const numericKey=Number(row[key!]),sourceId=String(row[id!]),signature=contentId(row);
            const prior=existing.all(table!,numericKey,sourceId);
            if(prior.length) {
              if(prior.length!==1||prior[0]!.numeric_key!==numericKey||prior[0]!.source_id!==sourceId||prior[0]!.signature!==signature) throw new Error(`Conflicting graph identity in ${table}: ${sourceId}`);
              if(release.partitioning==="connected-networks") throw new Error(`Source identity belongs to multiple networks: ${sourceId}`);
            } else insert.run(table!,numericKey,sourceId,signature);
          }
        }
        for(const row of db.prepare("SELECT * FROM access_points ORDER BY id").iterate()) {
          if(++work%1000===0) await checkpoint();
          const sourceId=String(row.id),signature=contentId(row),prior=accessById.get(sourceId);
          if(prior && (prior.signature!==signature||release.partitioning==="connected-networks")) throw new Error(`Conflicting access identity: ${sourceId}`);
          if(!prior) insertAccess.run(sourceId,signature);
        }
        identities.exec("COMMIT");
        }
        artifacts.push({id:artifact.id,nodes:Number(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n),directedEdges:Number(db.prepare("SELECT count(*) AS n FROM edges").get()!.n),physicalEdges:Number(db.prepare("SELECT count(*) AS n FROM physical_edges").get()!.n),accessPoints:Number(db.prepare("SELECT count(*) AS n FROM access_points").get()!.n)});
      } finally {db.close();await rm(file);}
    }
    return {id:release.id,verified:true,sections:release.sections.length,artifacts,rawBytes:release.artifacts.reduce((sum,item)=>sum+item.bytes,0),compressedBytes:release.artifacts.reduce((sum,item)=>sum+item.compressedBytes,0)};
  } finally {identities.close();await rm(temporary,{recursive:true,force:true});}
}
