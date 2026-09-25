import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packManifestSchema, type PackManifest } from "@/lib/contracts";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { areaGeometryBounds } from "../area-geometry";
import { namedAreaSearchKey, validateAndSortNamedAreas } from "../named-areas";
import { createPackSchema } from "./sqlite-writer";
import type { NormalizedNamedArea, NormalizedSearchRegion, PackAudit, PackBuildResult } from "../types";
import type { ProgressiveGraphStore } from "../progressive/store";
import { writeProgressiveTopology } from "./progressive-topology";
import { checkSQLiteIntegrity } from "../sqlite-integrity";
import { insertGraph, selectProgressiveEdges } from "../progressive/publish";
export type ProgressivePublishOptions = {
  outputRoot: string;
  manifest: PackManifest;
  namedAreas: NormalizedNamedArea[];
  searchRegions: NormalizedSearchRegion[];
  beforePublish?: (result: PackBuildResult) => void | Promise<void>;
  /** Serialize the final pointer switch with a caller-owned job-control transaction. */
  commitPublication?: (activate: () => Promise<void>) => Promise<void>;
  onProgress?: (stage: string) => void | Promise<void>;
  checkpoint?: () => Promise<void>;
};

function insertMetadata(db:DatabaseSync,manifest:PackManifest,areas:NormalizedNamedArea[],regions:NormalizedSearchRegion[],topologyHash:string):void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const areaInsert=db.prepare("INSERT INTO named_areas VALUES (?,?,?,?,?,?,?,?,?,?)");
    const areaSpatial=db.prepare("INSERT INTO named_area_spatial VALUES (?,?,?,?,?)");
    const aliasInsert=db.prepare("INSERT INTO named_area_aliases VALUES (?,?,?)");
    areas.forEach((area,index)=>{
      areaInsert.run(area.id,area.name,area.kind,area.context??null,area.bbox[0],area.bbox[1],area.bbox[2],area.bbox[3],JSON.stringify(area.geometry),JSON.stringify(area.sourceIds));
      areaSpatial.run(index+1,area.bbox[0],area.bbox[2],area.bbox[1],area.bbox[3]);
      for(const alias of area.aliases) aliasInsert.run(area.id,alias,namedAreaSearchKey(alias));
    });
    const regionInsert=db.prepare("INSERT INTO search_regions VALUES (?,?)");
    for(const region of regions) regionInsert.run(region.namedAreaId,region.displayOrder);
    const sourceInsert=db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)");
    for(const source of manifest.sources) sourceInsert.run(source.id,source.authority,source.dataset,source.version,source.retrievedAt,source.url,source.license,source.contentHash);
    const metadata:Record<string,string>={schemaVersion:manifest.schemaVersion,packId:manifest.id,dataVersion:manifest.dataVersion,builtAt:manifest.builtAt,
      compilerVersion:manifest.compilerVersion,metricAlgorithmVersion:manifest.metricAlgorithmVersion,topologyContentHash:topologyHash};
    const metaInsert=db.prepare("INSERT INTO metadata VALUES (?,?)");
    for(const [key,value] of Object.entries(metadata)) metaInsert.run(key,value);
    const migration=db.prepare("INSERT INTO schema_migrations VALUES (?,?)");
    for(let version=1;version<=6;version++) migration.run(version,manifest.builtAt);
    db.exec("COMMIT");
  } catch(error) {db.exec("ROLLBACK");throw error;}
}

function verifyStagedSources(store:ProgressiveGraphStore,manifest:PackManifest):void {
  const staged=[...store.database.prepare("SELECT record FROM sources ORDER BY id").iterate() as Iterable<{record:string}>]
    .map(({record})=>JSON.parse(record) as PackManifest["sources"][number]);
  const pinned=[...manifest.sources].sort((a,b)=>a.id.localeCompare(b.id));
  if(staged.length!==pinned.length)throw new Error("Staged source inventory differs from publication manifest");
  for(let index=0;index<pinned.length;index++){
    const actual=staged[index]!,expected=pinned[index]!;
    for(const key of ["id","authority","dataset","version","retrievedAt","url","license","contentHash"] as const)
      if(actual[key]!==expected[key])throw new Error(`Staged source ${actual.id} differs from publication manifest: ${key}`);
  }
}

async function activate(packRoot:string,dataVersion:string):Promise<void> {
  const pointer=path.join(packRoot,`.current-${randomUUID()}.json`);
  await writeFile(pointer,`${JSON.stringify({dataVersion,path:`${dataVersion}/manifest.json`},null,2)}\n`);
  await rename(pointer,path.join(packRoot,"current.json"));
}

async function commitActivation(options:ProgressivePublishOptions,packRoot:string,dataVersion:string):Promise<void> {
  let started=false,finished=false;
  const activateOnce=async()=>{
    if(started)throw new Error("Publication pointer activation was attempted twice");
    started=true;
    await activate(packRoot,dataVersion);
    finished=true;
  };
  if(options.commitPublication)await options.commitPublication(activateOnce);
  else await activateOnce();
  if(!finished)throw new Error("Publication commit hook returned without activating the pointer");
}

export async function publishProgressiveGraph(store:ProgressiveGraphStore,options:ProgressivePublishOptions):Promise<PackBuildResult> {
  const checkpoint=options.checkpoint ?? (async () => {});
  await checkpoint();
  const manifest=packManifestSchema.parse(options.manifest);
  verifyStagedSources(store,manifest);
  const packRoot=path.join(options.outputRoot,manifest.id),finalDir=path.join(packRoot,manifest.dataVersion);
  await mkdir(packRoot,{recursive:true});
  let existingText:string|undefined;
  try {existingText=await readFile(path.join(finalDir,"manifest.json"),"utf8");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(existingText!==undefined){
    const existing=packManifestSchema.parse(JSON.parse(existingText));
    if(JSON.stringify(existing)!==JSON.stringify(manifest))throw new Error(`Immutable pack version ${manifest.dataVersion} already differs`);
    const audit=JSON.parse(await readFile(path.join(finalDir,"audit.json"),"utf8")) as PackAudit;
    if(audit.packId!==manifest.id||audit.dataVersion!==manifest.dataVersion)throw new Error("Existing pack audit identity differs");
    const db=new DatabaseSync(path.join(finalDir,"pack.sqlite"),{readOnly:true});
    try {
      await checkSQLiteIntegrity(path.join(finalDir,"pack.sqlite"),db,checkpoint,"integrity_check");
      const meta=db.prepare("SELECT value FROM metadata WHERE key='topologyContentHash'").get() as {value:string}|undefined;
      if(!meta||meta.value!==audit.topologyContentHash)throw new Error("Existing pack topology hash differs from audit");
    } finally {db.close();}
    await checkpoint();
    await commitActivation(options,packRoot,manifest.dataVersion);
    return {packDirectory:finalDir,databasePath:path.join(finalDir,"pack.sqlite"),manifestPath:path.join(finalDir,"manifest.json"),auditPath:path.join(finalDir,"audit.json"),audit,reusedExisting:true};
  }
  const staging=path.join(packRoot,`.staging-${manifest.dataVersion}-${randomUUID()}`);
  await mkdir(staging);
  const databasePath=path.join(staging,"pack.sqlite");
  try {
    await options.onProgress?.("Select covered graph segments");
    const rejected=await selectProgressiveEdges(store,manifest.coverage.boundary,checkpoint);
    const sourceIds=new Set(manifest.sources.map(({id})=>id));
    const packArea={id:`pack:${manifest.id}`,name:manifest.name,kind:"pack" as const,aliases:[],bbox:areaGeometryBounds(manifest.coverage.boundary),geometry:manifest.coverage.boundary,sourceIds:[manifest.sources[0]!.id]};
    const providedAreas=options.namedAreas.some(({id})=>id===packArea.id)?options.namedAreas:[packArea,...options.namedAreas];
    const areas=validateAndSortNamedAreas(providedAreas,sourceIds);
    const areaIds=new Set(areas.map(({id})=>id));
    if(!options.searchRegions.length||options.searchRegions.some(({namedAreaId,displayOrder},i)=>!areaIds.has(namedAreaId)||displayOrder!==i)) throw new Error("Invalid ordered search regions");
    const db=new DatabaseSync(databasePath);
    let graph:{nodeCount:number;edgeCount:number;accessCount:number};
    let topology:Awaited<ReturnType<typeof writeProgressiveTopology>>;
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;");
      createPackSchema(db);
      await options.onProgress?.("Write covered graph");
      graph=await insertGraph(store,db,topologySha256(manifest.coverage.boundary),sourceIds,checkpoint);
      await options.onProgress?.("Derive global cycle feasibility");
      topology=await writeProgressiveTopology(db,manifest,checkpoint);
      insertMetadata(db,manifest,areas,options.searchRegions,topology.hash);
      await options.onProgress?.("Verify SQLite integrity");
      await checkSQLiteIntegrity(databasePath,db,checkpoint,"integrity_check");
      const foreign=db.prepare("PRAGMA foreign_key_check").get();
      if(foreign) throw new Error("Published graph has broken foreign keys");
    } finally {db.close();}
    const counts={public:0,unknown:0,private:0,closed:0,prohibited:0};
    for(const row of store.database.prepare("SELECT access_state AS state,count(*) AS n FROM edges WHERE id IN (SELECT id FROM selected_edges) GROUP BY access_state").iterate() as Iterable<{state:keyof typeof counts;n:number}>) counts[row.state]=row.n;
    const audit:PackAudit={schemaVersion:"6",packId:manifest.id,dataVersion:manifest.dataVersion,nodeCount:graph.nodeCount,directedEdgeCount:graph.edgeCount,accessPointCount:graph.accessCount,sourceCount:manifest.sources.length,rejectedWayCount:0,conflictCount:0,missingElevationNodeCount:0,missingElevationEdgeCount:0,accessStateCounts:counts,namedAreaCount:areas.length,searchRegionCount:options.searchRegions.length,rejectedCoverageEdgeCount:rejected,topologyContentHash:topology.hash,
      topologyProfiles:topology.profiles.map(({profile,hash,feasible,physical})=>({profile,contentHash:hash,nodeCount:0,physicalEdgeCount:physical,decisionNodeCount:0,decisionEdgeCount:0,blockCount:0,cycleBlockCount:0,networkCount:0,feasibleAccessPointCount:feasible,noCycleAccessPointCount:graph.accessCount-feasible}))};
    await writeFile(path.join(staging,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`);
    await writeFile(path.join(staging,"audit.json"),`${JSON.stringify(audit,null,2)}\n`);
    const result={packDirectory:staging,databasePath,manifestPath:path.join(staging,"manifest.json"),auditPath:path.join(staging,"audit.json"),audit,reusedExisting:false};
    await options.beforePublish?.(result);
    await rename(staging,finalDir);
    await checkpoint();
    await commitActivation(options,packRoot,manifest.dataVersion);
    return {...result,packDirectory:finalDir,databasePath:path.join(finalDir,"pack.sqlite"),manifestPath:path.join(finalDir,"manifest.json"),auditPath:path.join(finalDir,"audit.json")};
  } catch(error) {await rm(staging,{recursive:true,force:true});throw error;}
}
