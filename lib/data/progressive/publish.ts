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

export type ProgressivePublishOptions = {
  outputRoot: string;
  manifest: PackManifest;
  namedAreas: NormalizedNamedArea[];
  searchRegions: NormalizedSearchRegion[];
  beforePublish?: (result: PackBuildResult) => void | Promise<void>;
  onProgress?: (stage: string) => void;
};

function bounds(geometry: CompiledEdge["geometry"]): [number,number,number,number] {
  let minLon=Infinity,maxLon=-Infinity,minLat=Infinity,maxLat=-Infinity;
  for (const [lon,lat] of geometry) { minLon=Math.min(minLon,lon);maxLon=Math.max(maxLon,lon);minLat=Math.min(minLat,lat);maxLat=Math.max(maxLat,lat); }
  return [minLon,maxLon,minLat,maxLat];
}

/** Selects whole directed segments; the source union in the staging DB is never clipped. */
export function selectProgressiveEdges(store: ProgressiveGraphStore, coverage: AreaGeometry): number {
  const db=store.database;
  db.exec("DROP TABLE IF EXISTS temp.selected_edges; CREATE TEMP TABLE selected_edges(id TEXT PRIMARY KEY) STRICT;");
  const add=db.prepare("INSERT INTO selected_edges VALUES (?)");
  let rejected=0;
  for (const edge of store.iterateEdges()) {
    if (edge.edgeClass !== "trail") continue;
    if (edgeInsideCoverage(edge,coverage)) add.run(edge.id);
    else rejected++;
  }
  return rejected;
}

function insertGraph(store: ProgressiveGraphStore, output: DatabaseSync, coverageHash: string): {nodeCount:number;edgeCount:number;accessCount:number} {
  const stage=store.database;
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
      const node=JSON.parse(row.record) as NormalizedNode;
      if (node.elevationM===null) throw new Error(`Missing elevation for published node ${node.id}`);
      insertNode.run(node.id,++nodeCount,node.lon,node.lat,node.elevationM,JSON.stringify(node.flags));
      spatialNode.run(nodeCount,node.lon,node.lon,node.lat,node.lat);
    }
    const nodeKey=output.prepare("SELECT node_key FROM nodes WHERE id=?");
    const insertPhysical=output.prepare("INSERT INTO physical_edges VALUES (?,?,?,?,?)");
    let physicalCount=0;
    for (const row of stage.prepare("SELECT DISTINCT stable_physical_id AS id FROM edges WHERE id IN (SELECT id FROM selected_edges) ORDER BY stable_physical_id").iterate() as Iterable<{id:string}>) {
      const members=stage.prepare("SELECT record FROM edges WHERE stable_physical_id=? AND id IN (SELECT id FROM selected_edges) ORDER BY id").iterate(row.id) as Iterable<{record:string}>;
      let first: CompiledEdge|undefined, firstGeometry="", reverse="", firstKey=0,lastKey=0;
      for (const member of members) {
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
      const edge=JSON.parse(row.record) as CompiledEdge;
      if (!edge.edgeClass || !edge.elevationProfile || edge.gainM===null || edge.lossM===null) throw new Error(`Trail edge ${edge.id} lacks complete elevation metrics`);
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
      const point=JSON.parse(row.record) as NormalizedAccessPoint;
      if (!(stage.prepare("SELECT 1 FROM used_nodes WHERE id=?").get(point.nodeId))) continue;
      const fields=[point.knownConnectivity,point.inclusiveConnectivity,point.knownOutDegree,point.inclusiveOutDegree,point.nearbyBuildingCount,point.reachableTrailKm,point.trailComponentId,point.portalRoadClass];
      if (fields.some((value)=>value===undefined||value===null)) throw new Error(`Access point ${point.id} is missing ranking or portal fields`);
      insertAccess.run(point.id,point.nodeId,point.name,point.kind,point.accessState,point.confidence,point.parkingEvidence,JSON.stringify(point.sourceRefs),
        point.knownConnectivity!,point.inclusiveConnectivity!,point.knownOutDegree!,point.inclusiveOutDegree!,point.nearbyBuildingCount!,point.reachableTrailKm!,point.trailComponentId!,point.portalRoadClass!,point.parkingDistanceM??null);
      accessCount++;
    }
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

export async function publishProgressiveGraph(store:ProgressiveGraphStore,options:ProgressivePublishOptions):Promise<PackBuildResult> {
  const manifest=packManifestSchema.parse(options.manifest);
  const packRoot=path.join(options.outputRoot,manifest.id),finalDir=path.join(packRoot,manifest.dataVersion);
  await mkdir(packRoot,{recursive:true});
  try {
    const existing=JSON.parse(await readFile(path.join(finalDir,"manifest.json"),"utf8")) as PackManifest;
    if(JSON.stringify(existing)!==JSON.stringify(manifest)) throw new Error(`Immutable pack version ${manifest.dataVersion} already differs`);
    const audit=JSON.parse(await readFile(path.join(finalDir,"audit.json"),"utf8")) as PackAudit;
    return {packDirectory:finalDir,databasePath:path.join(finalDir,"pack.sqlite"),manifestPath:path.join(finalDir,"manifest.json"),auditPath:path.join(finalDir,"audit.json"),audit,reusedExisting:true};
  } catch(error) {if(error instanceof Error && error.message.startsWith("Immutable pack version")) throw error;}
  const staging=path.join(packRoot,`.staging-${manifest.dataVersion}-${randomUUID()}`);
  await mkdir(staging);
  const databasePath=path.join(staging,"pack.sqlite");
  try {
    options.onProgress?.("Select covered graph segments");
    const rejected=selectProgressiveEdges(store,manifest.coverage.boundary);
    const sourceIds=new Set(manifest.sources.map(({id})=>id));
    const areas=validateAndSortNamedAreas([{id:`pack:${manifest.id}`,name:manifest.name,kind:"pack",aliases:[],bbox:areaGeometryBounds(manifest.coverage.boundary),geometry:manifest.coverage.boundary,sourceIds:[manifest.sources[0]!.id]},...options.namedAreas],sourceIds);
    const areaIds=new Set(areas.map(({id})=>id));
    if(!options.searchRegions.length||options.searchRegions.some(({namedAreaId,displayOrder},i)=>!areaIds.has(namedAreaId)||displayOrder!==i)) throw new Error("Invalid ordered search regions");
    const db=new DatabaseSync(databasePath);
    let graph:{nodeCount:number;edgeCount:number;accessCount:number};
    let topology:ReturnType<typeof writeProgressiveTopology>;
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;");
      createPackSchema(db);
      options.onProgress?.("Write covered graph");
      graph=insertGraph(store,db,topologySha256(manifest.coverage.boundary));
      options.onProgress?.("Derive global cycle feasibility");
      topology=writeProgressiveTopology(db,manifest);
      insertMetadata(db,manifest,areas,options.searchRegions,topology.hash);
      const integrity=db.prepare("PRAGMA integrity_check").get() as {integrity_check:string};
      if(integrity.integrity_check!=="ok") throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
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
    const pointer=path.join(packRoot,`.current-${randomUUID()}.json`);
    await writeFile(pointer,`${JSON.stringify({dataVersion:manifest.dataVersion,path:`${manifest.dataVersion}/manifest.json`},null,2)}\n`);
    await rename(pointer,path.join(packRoot,"current.json"));
    return {...result,packDirectory:finalDir,databasePath:path.join(finalDir,"pack.sqlite"),manifestPath:path.join(finalDir,"manifest.json"),auditPath:path.join(finalDir,"audit.json")};
  } catch(error) {await rm(staging,{recursive:true,force:true});throw error;}
}
