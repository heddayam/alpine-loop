import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import { packSourceSchema } from "@/lib/contracts/manifest";
import type { AreaGeometry } from "./area-geometry";
import { contentId } from "@/lib/coverage/geometry";
import { auditPreparedGraph, readPreparedSources } from "./prepared-audit";
import { writeJsonAtomically } from "./source-cache";
import { sameSourceContent } from "./source-metadata";

export type PreparedReleaseOptions = Pick<DataRelease,"geometry"|"sources"|"regions"|"builtAt"|"compilerVersion"|"metricAlgorithmVersion"> & {
  databasePath: string; outputRoot: string; limitations?: string[]; checkpoint?: () => Promise<void>;
  area: { id: string; name?: string; inputFingerprint: string; startGeometry: AreaGeometry; maximumRouteMiles: number; bufferMiles: number };
  publish?: boolean;
};
export function preparedReleaseId(input: Pick<PreparedReleaseOptions,"geometry"|"sources"|"regions"|"builtAt"|"compilerVersion"|"metricAlgorithmVersion"|"limitations"|"area">): string {
  const {id,inputFingerprint,startGeometry,maximumRouteMiles,bufferMiles}=input.area;
  // Hash the same field representation used by export and checkpoint parsing.
  // Producer object insertion order must not change identity after a round trip.
  const sources=input.sources.map(source=>packSourceSchema.parse(source));
  return `area-${contentId({ area:{id,inputFingerprint,startGeometry,maximumRouteMiles,bufferMiles}, geometry:input.geometry, sources, regions:input.regions.map(({id,geometry,sourceIds})=>({id,geometry,sourceIds})), compilerVersion:input.compilerVersion, metricAlgorithmVersion:input.metricAlgorithmVersion, builtAt:input.builtAt, limitations:input.limitations ?? [] }).slice(0,32)}`;
}

const count=z.number().int().nonnegative();
const summarySchema=z.object({id:z.string(),nodes:count,directedEdges:count,physicalEdges:count,accessPoints:count}).strict();
const receiptSchema=z.object({key:z.string(),compressedHash:z.string(),sources:z.array(packSourceSchema),summary:summarySchema}).strict();
const auditKey=(artifact:DataRelease["artifacts"][number])=>contentId({version:2,id:artifact.id,bytes:artifact.bytes,graphId:artifact.graphId,geometry:artifact.geometry,accessPolicyVersion:artifact.accessPolicyVersion});
const receiptPath=(root:string,id:string)=>path.join(root,".audits",`${id}.json`);
async function fileHash(file:string,checkpoint:()=>Promise<void>):Promise<string> {
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(file)) {hash.update(chunk);await checkpoint();}
  return hash.digest("hex");
}
function graphSummary(db:DatabaseSync,id:string) {
  return {id,nodes:Number(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n),directedEdges:Number(db.prepare("SELECT count(*) AS n FROM edges").get()!.n),physicalEdges:Number(db.prepare("SELECT count(*) AS n FROM physical_edges").get()!.n),accessPoints:Number(db.prepare("SELECT count(*) AS n FROM access_points").get()!.n)};
}
async function writeAuditReceipt(root:string,artifact:DataRelease["artifacts"][number],compressedHash:string,sources:DataRelease["sources"],summary:z.infer<typeof summarySchema>) {
  await mkdir(path.join(root,".audits"),{recursive:true});
  await writeJsonAtomically(receiptPath(root,artifact.id),{key:auditKey(artifact),compressedHash,sources,summary});
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
    const policy=input.prepare("SELECT value FROM metadata WHERE key='access_policy_version'").get()?.value;
    const accessPolicyVersion=typeof policy==='string'?policy:undefined;
    await auditPreparedGraph(input,{id,geometry:options.geometry,sources:options.sources,accessPolicyVersion},checkpoint);
    const hash=createHash("sha256"); let bytes=0;
    const compressed=path.join(temporary,"area.gz");
    const measure=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);checkpoint().then(()=>done(null,chunk),done);}});
    await pipeline(createReadStream(options.databasePath),measure,createGzip({level:6}),createWriteStream(compressed));
    const digest=hash.digest("hex"), relative=`objects/${digest}.sqlite.gz`;
    const artifact={id:digest,path:relative,bytes,compressedBytes:(await stat(compressed)).size,geometry:options.geometry,graphId:id,regionId:options.area.name?options.area.id:undefined,startGeometry:options.area.startGeometry,accessPolicyVersion};
    const release=dataReleaseSchema.parse({schemaVersion:1,graphSchemaVersion:"7",partitioning:"local-areas",id,builtAt:options.builtAt,compilerVersion:options.compilerVersion,metricAlgorithmVersion:options.metricAlgorithmVersion,sources:options.sources,regions:options.regions,geometry:options.geometry,limitations:options.limitations??[],sections:[{id:options.area.id,name:options.area.name,geometry:options.area.startGeometry,artifactIds:[digest],area:{maximumRouteMiles:options.area.maximumRouteMiles,bufferMiles:options.area.bufferMiles}}],artifacts:[artifact]});
    await checkpoint();
    await rename(compressed,path.join(options.outputRoot,relative));
    await writeAuditReceipt(options.outputRoot,artifact,await fileHash(path.join(options.outputRoot,relative),checkpoint),options.sources,graphSummary(input,digest));
    if(options.publish!==false) await publishPreparedCatalog(release,options.outputRoot,checkpoint);
    return release;
  } finally {input.close();await rm(temporary,{recursive:true,force:true});}
}

/** Validate every immutable object, including reused objects, before one atomic activation. */
export async function publishPreparedCatalog(release:DataRelease,outputRoot:string,checkpoint:()=>Promise<void>=async()=>{}):Promise<void> {
  const candidate=dataReleaseSchema.parse(release);
  await auditCatalog(candidate,outputRoot,checkpoint,true);
  await checkpoint();
  await writeJsonAtomically(path.join(outputRoot,"release.json"),candidate);
}

/** Inspect and publication share the same streamed transport and graph integrity checks. */
export async function inspectPreparedRelease(manifestPath:string,checkpoint:()=>Promise<void>=async()=>{}) {
  const release=dataReleaseSchema.parse(JSON.parse(await readFile(manifestPath,"utf8")));
  return auditCatalog(release,path.dirname(manifestPath),checkpoint);
}

async function auditCatalog(release:DataRelease,outputRoot:string,checkpoint:()=>Promise<void>,reuseAudits=false) {
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
      // Immutable transport is hashed every time. Only a matching semantic audit
      // can skip decompression/scanning; inspect always performs the full audit.
      const compressedHash=await fileHash(compressed,checkpoint);
      if(reuseAudits && release.partitioning==="local-areas") {
        const receipt=await readFile(receiptPath(outputRoot,artifact.id),"utf8").then(raw=>receiptSchema.parse(JSON.parse(raw))).catch(()=>null);
        if(receipt && receipt.key===auditKey(artifact) && receipt.compressedHash===compressedHash && receipt.summary.id===artifact.id && receipt.sources.every(source=>release.sources.some(candidate=>sameSourceContent(candidate,source)))) {
          artifacts.push(receipt.summary);continue;
        }
      }
      const hash=createHash("sha256");let bytes=0;
      const verify=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);if(bytes>artifact.bytes) done(new Error("Artifact exceeds declared size"));else checkpoint().then(()=>done(null,chunk),done);}});
      await pipeline(createReadStream(compressed),createGunzip(),verify,createWriteStream(file));
      if(bytes!==artifact.bytes||hash.digest("hex")!==artifact.id) throw new Error(`Artifact checksum/size differs: ${artifact.id}`);
      const db=new DatabaseSync(file,{readOnly:true});
      try {
        db.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
        await auditPreparedGraph(db,{id:artifact.graphId??release.id,geometry:release.partitioning==="connected-networks"||release.partitioning==="local-areas"?artifact.geometry:release.geometry,sources:release.sources,accessPolicyVersion:artifact.accessPolicyVersion},checkpoint,true);
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
        const summary=graphSummary(db,artifact.id);
        artifacts.push(summary);
        if(release.partitioning==="local-areas") {
          await writeAuditReceipt(outputRoot,artifact,compressedHash,readPreparedSources(db),summary);
        }
      } finally {db.close();await rm(file);}
    }
    return {id:release.id,verified:true,sections:release.sections.length,artifacts,rawBytes:release.artifacts.reduce((sum,item)=>sum+item.bytes,0),compressedBytes:release.artifacts.reduce((sum,item)=>sum+item.compressedBytes,0)};
  } finally {identities.close();await rm(temporary,{recursive:true,force:true});}
}
