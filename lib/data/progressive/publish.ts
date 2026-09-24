import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packManifestSchema, type PackManifest } from "@/lib/contracts";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { areaGeometryBounds, edgeInsideCoverage, type AreaGeometry } from "../area-geometry";
import { namedAreaSearchKey, validateAndSortNamedAreas } from "../named-areas";
import { createPackSchema } from "../sqlite-writer";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNamedArea, NormalizedNode, NormalizedSearchRegion, PackAudit, PackBuildResult } from "../types";
import type { ProgressiveGraphStore } from "./store";
import { writeProgressiveTopology } from "./topology";
import { checkSQLiteIntegrity } from "../sqlite-integrity";

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

function bounds(geometry: CompiledEdge["geometry"]): [number,number,number,number] {
  let minLon=Infinity,maxLon=-Infinity,minLat=Infinity,maxLat=-Infinity;
  for (const [lon,lat] of geometry) { minLon=Math.min(minLon,lon);maxLon=Math.max(maxLon,lon);minLat=Math.min(minLat,lat);maxLat=Math.max(maxLat,lat); }
  return [minLon,maxLon,minLat,maxLat];
}

/** Selects whole directed segments; the source union in the staging DB is never clipped. */
export async function selectProgressiveEdges(store: ProgressiveGraphStore, coverage: AreaGeometry, checkpoint: () => Promise<void> = async () => {}): Promise<number> {
  let work=0;
  await checkpoint();
  const db=store.database;
  db.exec("DROP TABLE IF EXISTS temp.selected_edges; CREATE TEMP TABLE selected_edges(id TEXT PRIMARY KEY) STRICT;");
  const add=db.prepare("INSERT INTO selected_edges VALUES (?)");
  let rejected=0;
  for (const edge of store.iterateEdges()) {
    if (++work%1000===0) await checkpoint();
    if (edge.edgeClass !== "trail") continue;
    if (edgeInsideCoverage(edge,coverage)) add.run(edge.id);
    else rejected++;
  }
  return rejected;
}

async function insertGraph(store: ProgressiveGraphStore, output: DatabaseSync, coverageHash: string, sourceIds: ReadonlySet<string>, checkpoint: () => Promise<void>): Promise<{nodeCount:number;edgeCount:number;accessCount:number}> {
  let work=0;
  await checkpoint();
  const stage=store.database;
  const assertRefs=(refs:readonly string[],id:string)=>{
    for(const sourceId of refs)if(!sourceIds.has(sourceId))throw new Error(`Unknown source ${sourceId} on ${id}`);
  };
  output.exec("BEGIN IMMEDIATE");
  try {
    const selected=stage.prepare("SELECT s.record FROM edges s JOIN selected_edges x ON x.id=s.id ORDER BY s.id").iterate() as Iterable<{record:string}>;
    // Disk tables hold only referenced identities; the JS heap holds one source row at a time.
    stage.exec("DROP TABLE IF EXISTS temp.used_nodes; CREATE TEMP TABLE used_nodes(id TEXT PRIMARY KEY) STRICT;");
    stage.exec("INSERT OR IGNORE INTO used_nodes SELECT from_node FROM edges WHERE id IN (SELECT id FROM selected_edges);");
    stage.exec("INSERT OR IGNORE INTO used_nodes SELECT to_node FROM edges WHERE id IN (SELECT id FROM selected_edges);");
    const insertNode=output.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?)");
    const spatialNode=output.prepare("INSERT INTO node_spatial VALUES (?,?,?,?,?)");
    let nodeCount=0;
    for (const row of stage.prepare("SELECT n.record FROM nodes n JOIN used_nodes u ON u.id=n.id ORDER BY n.id").iterate() as Iterable<{record:string}>) {
      if (++work%1000===0) await checkpoint();
      const node=JSON.parse(row.record) as NormalizedNode;
      if (node.elevationM===null) throw new Error(`Missing elevation for published node ${node.id}`);
      assertRefs(node.sourceRefs,node.id);
      insertNode.run(node.id,++nodeCount,node.lon,node.lat,node.elevationM,JSON.stringify(node.flags));
      spatialNode.run(nodeCount,node.lon,node.lon,node.lat,node.lat);
    }
    const nodeKey=output.prepare("SELECT node_key FROM nodes WHERE id=?");
    const insertPhysical=output.prepare("INSERT INTO physical_edges VALUES (?,?,?,?,?)");
    let physicalCount=0;
    for (const row of stage.prepare("SELECT DISTINCT stable_physical_id AS id FROM edges WHERE id IN (SELECT id FROM selected_edges) ORDER BY stable_physical_id").iterate() as Iterable<{id:string}>) {
      if (++work%1000===0) await checkpoint();
      const members=stage.prepare("SELECT record FROM edges WHERE stable_physical_id=? AND id IN (SELECT id FROM selected_edges) ORDER BY id").iterate(row.id) as Iterable<{record:string}>;
      let first: CompiledEdge|undefined, firstGeometry="", reverse="", firstKey=0,lastKey=0;
      for (const member of members) {
        if (++work%1000===0) await checkpoint();
        const edge=JSON.parse(member.record) as CompiledEdge;
        const geometry=canonicalTopologyJson(edge.geometry);
        if (!first) {
          first=edge; firstGeometry=geometry;reverse=canonicalTopologyJson([...edge.geometry].reverse());
          firstKey=Number((nodeKey.get(edge.fromNode) as {node_key:number}|undefined)?.node_key);
          lastKey=Number((nodeKey.get(edge.toNode) as {node_key:number}|undefined)?.node_key);
        } else if (geometry!==firstGeometry && geometry!==reverse) throw new Error(`Inconsistent physical geometry ${row.id}`);
        if (first && (![first.fromNode,first.toNode].includes(edge.fromNode) ||
          ![first.fromNode,first.toNode].includes(edge.toNode) ||
          new Set([edge.fromNode,edge.toNode]).size !== new Set([first.fromNode,first.toNode]).size))
          throw new Error(`Inconsistent physical endpoints ${row.id}`);
        if (!Number.isInteger(firstKey)||!Number.isInteger(lastKey)) throw new Error(`Missing physical endpoints ${row.id}`);
      }
      if (!first) continue;
      insertPhysical.run(++physicalCount,row.id,Math.min(firstKey,lastKey),Math.max(firstKey,lastKey),topologySha256(firstGeometry<reverse?firstGeometry:reverse));
    }
    const physicalKey=output.prepare("SELECT physical_edge_key FROM physical_edges WHERE stable_physical_id=?");
    const insertEdge=output.prepare("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const spatialEdge=output.prepare("INSERT INTO edge_spatial VALUES (?,?,?,?,?)");
    let edgeCount=0;
    for (const row of selected) {
      if (++work%1000===0) await checkpoint();
      const edge=JSON.parse(row.record) as CompiledEdge;
      const metricValues=[edge.lengthM,edge.gainM,edge.lossM,edge.maxElevationM];
      if (!edge.edgeClass || !edge.elevationProfile || edge.elevationProfile.length<2 || metricValues.some((value)=>value===null||!Number.isFinite(value)) ||
        edge.lengthM<0 || edge.gainM!<0 || edge.lossM!<0 || (edge.maxSustainedGradePct!==null && !Number.isFinite(edge.maxSustainedGradePct)))
        throw new Error(`Trail edge ${edge.id} lacks complete elevation metrics`);
      const from=output.prepare("SELECT lon,lat,elevation_m FROM nodes WHERE id=?").get(edge.fromNode) as {lon:number;lat:number;elevation_m:number}|undefined;
      const to=output.prepare("SELECT lon,lat,elevation_m FROM nodes WHERE id=?").get(edge.toNode) as {lon:number;lat:number;elevation_m:number}|undefined;
      const first=edge.geometry[0],last=edge.geometry.at(-1),firstElevation=edge.elevationProfile[0],lastElevation=edge.elevationProfile.at(-1);
      if(!from||!to||!first||!last||!firstElevation||!lastElevation||
        Math.abs(first[0]-from.lon)>1e-10||Math.abs(first[1]-from.lat)>1e-10||Math.abs(last[0]-to.lon)>1e-10||Math.abs(last[1]-to.lat)>1e-10||
        Math.abs(firstElevation.distanceMeters)>1e-6||Math.abs(lastElevation.distanceMeters-edge.lengthM)>1e-6||
        Math.abs(firstElevation.elevationMeters-from.elevation_m)>1e-6||Math.abs(lastElevation.elevationMeters-to.elevation_m)>1e-6)
        throw new Error(`Trail edge ${edge.id} disagrees with endpoint geometry or elevation`);
      assertRefs(edge.sourceRefs,edge.id);
      const physical=physicalKey.get(edge.stablePhysicalId) as {physical_edge_key:number}|undefined;
      if (!physical) throw new Error(`Missing physical key for ${edge.id}`);
      insertEdge.run(edge.id,++edgeCount,physical.physical_edge_key,edge.fromNode,edge.toNode,JSON.stringify(edge.geometry),edge.lengthM,
        edge.gainM,edge.lossM,edge.maxElevationM,edge.maxSustainedGradePct,
        JSON.stringify(edge.elevationProfile.map(({distanceMeters,elevationMeters})=>[distanceMeters,elevationMeters])),
        edge.accessState,edge.edgeClass,JSON.stringify(edge.sourceRefs),JSON.stringify(edge.flags));
      spatialEdge.run(edgeCount,...bounds(edge.geometry));
    }
    const insertAccess=output.prepare("INSERT INTO access_points VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    let accessCount=0;
    const derived=Number((stage.prepare("SELECT count(*) AS n FROM derived_portals WHERE coverage_hash=?").get(coverageHash) as {n:number}).n);
    const accessRows=derived
      ? stage.prepare("SELECT record FROM derived_portals WHERE coverage_hash=? ORDER BY id").iterate(coverageHash)
      : stage.prepare("SELECT record FROM access_points ORDER BY id").iterate();
    for (const row of accessRows as Iterable<{record:string}>) {
      if (++work%1000===0) await checkpoint();
      const point=JSON.parse(row.record) as NormalizedAccessPoint;
      if (!(stage.prepare("SELECT 1 FROM used_nodes WHERE id=?").get(point.nodeId))) continue;
      assertRefs(point.sourceRefs,point.id);
      const fields=[point.knownConnectivity,point.inclusiveConnectivity,point.knownOutDegree,point.inclusiveOutDegree,point.nearbyBuildingCount,point.reachableTrailKm,point.trailComponentId,point.portalRoadClass];
      if (fields.some((value)=>value===undefined||value===null)) throw new Error(`Access point ${point.id} is missing ranking or portal fields`);
      insertAccess.run(point.id,point.nodeId,point.name,point.kind,point.accessState,point.confidence,point.parkingEvidence,JSON.stringify(point.sourceRefs),
        point.knownConnectivity!,point.inclusiveConnectivity!,point.knownOutDegree!,point.inclusiveOutDegree!,point.nearbyBuildingCount!,point.reachableTrailKm!,point.trailComponentId!,point.portalRoadClass!,point.parkingDistanceM??null);
      accessCount++;
    }
    await checkpoint();
    output.exec("COMMIT");
    return {nodeCount,edgeCount,accessCount};
  } catch(error) { output.exec("ROLLBACK");throw error; }
}

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
