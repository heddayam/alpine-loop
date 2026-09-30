import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import type { AreaGeometry } from "../area-geometry";
import { prepareAreaGeometry } from "@/lib/graph/geometry";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "../types";
import type { ProgressiveGraphStore } from "./store";
import { preparedEdgeBounds } from "../prepared-spatial-index";

/** Stable across independently prepared networks; uniqueness is checked in SQLite and at export. */
export function stableGraphKey(kind: "node" | "physical" | "edge", id: string): number {
  return Number.parseInt(createHash("sha256").update(`${kind}\0${id}`).digest("hex").slice(0, 13), 16) || 1;
}
/** Selects whole directed segments; the source union in the staging DB is never clipped. */
export async function selectProgressiveEdges(store: ProgressiveGraphStore, coverage: AreaGeometry, checkpoint: () => Promise<void> = async () => {}): Promise<number> {
  let work=0;
  await checkpoint();
  const db=store.database;
  db.exec("DROP TABLE IF EXISTS temp.selected_edges; CREATE TEMP TABLE selected_edges(id TEXT PRIMARY KEY) STRICT;");
  const add=db.prepare("INSERT INTO selected_edges VALUES (?)");
  const boundary=prepareAreaGeometry(coverage);
  let rejected=0;
  for (const edge of store.iterateEdges()) {
    if (++work%1000===0) await checkpoint();
    if (edge.edgeClass !== "trail") continue;
    let inside=edge.geometry.length>=2;
    for(let i=1;inside&&i<edge.geometry.length;i++) inside=boundary.containsSegment(edge.geometry[i-1]!,edge.geometry[i]!);
    if (inside) add.run(edge.id);
    else rejected++;
  }
  return rejected;
}

/** Regional preparation may defer spatial writes until after graph compression. */
export async function insertGraph(store: ProgressiveGraphStore, output: DatabaseSync, coverageHash: string, sourceIds: ReadonlySet<string>, checkpoint: () => Promise<void>, stableKeys = false, {spatialIndexes=true}:{spatialIndexes?:boolean}={}): Promise<{nodeCount:number;edgeCount:number;accessCount:number}> {
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
    const spatialNode=spatialIndexes?output.prepare("INSERT INTO node_spatial VALUES (?,?,?,?,?)"):undefined;
    let nodeCount=0;
    for (const row of stage.prepare("SELECT n.record FROM nodes n JOIN used_nodes u ON u.id=n.id ORDER BY n.id").iterate() as Iterable<{record:string}>) {
      if (++work%1000===0) await checkpoint();
      const node=JSON.parse(row.record) as NormalizedNode;
      if (node.elevationM===null) throw new Error(`Missing elevation for published node ${node.id}`);
      assertRefs(node.sourceRefs,node.id);
      nodeCount++;
      const key=stableKeys?stableGraphKey("node",node.id):nodeCount;
      insertNode.run(node.id,key,node.lon,node.lat,node.elevationM,JSON.stringify(node.flags));
      spatialNode?.run(key,node.lon,node.lon,node.lat,node.lat);
    }
    const nodeKey=output.prepare("SELECT node_key FROM nodes WHERE id=?");
    const insertPhysical=output.prepare("INSERT INTO physical_edges VALUES (?,?,?,?,?)");
    // Find one physical edge first, then probe installed membership per member.
    let physicalCount=0;
    const physicalMembers=stage.prepare("SELECT e.record FROM edges e CROSS JOIN selected_edges s ON s.id=e.id WHERE e.stable_physical_id=? ORDER BY e.id");
    for (const row of stage.prepare("SELECT DISTINCT stable_physical_id AS id FROM edges WHERE id IN (SELECT id FROM selected_edges) ORDER BY stable_physical_id").iterate() as Iterable<{id:string}>) {
      if (++work%1000===0) await checkpoint();
      const members=physicalMembers.iterate(row.id) as Iterable<{record:string}>;
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
      insertPhysical.run(stableKeys?stableGraphKey("physical",row.id):++physicalCount,row.id,Math.min(firstKey,lastKey),Math.max(firstKey,lastKey),topologySha256(firstGeometry<reverse?firstGeometry:reverse));
    }
    const endpoint=output.prepare("SELECT lon,lat,elevation_m FROM nodes WHERE id=?");
    const physicalKey=output.prepare("SELECT physical_edge_key FROM physical_edges WHERE stable_physical_id=?");
    const insertEdge=output.prepare("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const spatialEdge=spatialIndexes?output.prepare("INSERT INTO edge_spatial VALUES (?,?,?,?,?)"):undefined;
    let edgeCount=0;
    for (const row of selected) {
      if (++work%1000===0) await checkpoint();
      const edge=JSON.parse(row.record) as CompiledEdge;
      const metricValues=[edge.lengthM,edge.gainM,edge.lossM,edge.maxElevationM];
      if (!edge.edgeClass || !edge.elevationProfile || edge.elevationProfile.length<2 || metricValues.some((value)=>value===null||!Number.isFinite(value)) ||
        edge.lengthM<0 || edge.gainM!<0 || edge.lossM!<0 || (edge.maxSustainedGradePct!==null && !Number.isFinite(edge.maxSustainedGradePct)))
        throw new Error(`Trail edge ${edge.id} lacks complete elevation metrics`);
      const from=endpoint.get(edge.fromNode) as {lon:number;lat:number;elevation_m:number}|undefined;
      const to=endpoint.get(edge.toNode) as {lon:number;lat:number;elevation_m:number}|undefined;
      const first=edge.geometry[0],last=edge.geometry.at(-1),firstElevation=edge.elevationProfile[0],lastElevation=edge.elevationProfile.at(-1);
      if(!from||!to||!first||!last||!firstElevation||!lastElevation||
        Math.abs(first[0]-from.lon)>1e-10||Math.abs(first[1]-from.lat)>1e-10||Math.abs(last[0]-to.lon)>1e-10||Math.abs(last[1]-to.lat)>1e-10||
        Math.abs(firstElevation.distanceMeters)>1e-6||Math.abs(lastElevation.distanceMeters-edge.lengthM)>1e-6||
        Math.abs(firstElevation.elevationMeters-from.elevation_m)>1e-6||Math.abs(lastElevation.elevationMeters-to.elevation_m)>1e-6)
        throw new Error(`Trail edge ${edge.id} disagrees with endpoint geometry or elevation`);
      assertRefs(edge.sourceRefs,edge.id);
      const physical=physicalKey.get(edge.stablePhysicalId) as {physical_edge_key:number}|undefined;
      if (!physical) throw new Error(`Missing physical key for ${edge.id}`);
      edgeCount++;
      const key=stableKeys?stableGraphKey("edge",edge.id):edgeCount;
      insertEdge.run(edge.id,key,physical.physical_edge_key,edge.fromNode,edge.toNode,JSON.stringify(edge.geometry),edge.lengthM,
        edge.gainM,edge.lossM,edge.maxElevationM,edge.maxSustainedGradePct,
        JSON.stringify(edge.elevationProfile.map(({distanceMeters,elevationMeters})=>[distanceMeters,elevationMeters])),
        edge.accessState,edge.edgeClass,JSON.stringify(edge.sourceRefs),JSON.stringify(edge.flags));
      if (spatialEdge) spatialEdge.run(key,...preparedEdgeBounds(edge.geometry));
    }
    const insertAccess=output.prepare("INSERT INTO access_points(id,node_id,name,kind,access_state,confidence,parking_evidence,source_refs,known_connectivity,inclusive_connectivity,known_out_degree,inclusive_out_degree,nearby_building_count,reachable_trail_km,trail_component_id,portal_road_class,parking_distance_m) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertWitness=output.prepare("INSERT INTO entry_witnesses VALUES (?,?)");
    const usedNode=stage.prepare("SELECT 1 FROM used_nodes WHERE id=?");
    let accessCount=0;
    const derived=Number((stage.prepare("SELECT count(*) AS n FROM derived_portals WHERE coverage_hash=?").get(coverageHash) as {n:number}).n);
    const accessRows=derived
      ? stage.prepare("SELECT record FROM derived_portals WHERE coverage_hash=? ORDER BY id").iterate(coverageHash)
      : stage.prepare("SELECT record FROM access_points ORDER BY id").iterate();
    for (const row of accessRows as Iterable<{record:string}>) {
      if (++work%1000===0) await checkpoint();
      const point=JSON.parse(row.record) as NormalizedAccessPoint;
      if (!(usedNode.get(point.nodeId))) continue;
      assertRefs(point.sourceRefs,point.id);
      const fields=[point.knownConnectivity,point.inclusiveConnectivity,point.knownOutDegree,point.inclusiveOutDegree,point.reachableTrailKm,point.trailComponentId,point.portalRoadClass];
      if (fields.some((value)=>value===undefined||value===null)) throw new Error(`Access point ${point.id} is missing ranking or portal fields`);
      insertAccess.run(point.id,point.nodeId,point.name,point.kind,point.accessState,point.confidence,point.parkingEvidence,JSON.stringify(point.sourceRefs),
        point.knownConnectivity!,point.inclusiveConnectivity!,point.knownOutDegree!,point.inclusiveOutDegree!,point.nearbyBuildingCount??null,point.reachableTrailKm!,point.trailComponentId!,point.portalRoadClass!,point.parkingDistanceM??null);
      if (point.entryWitness) insertWitness.run(point.id,JSON.stringify(point.entryWitness));
      accessCount++;
    }
    await checkpoint();
    output.exec("COMMIT");
    return {nodeCount,edgeCount,accessCount};
  } catch(error) { output.exec("ROLLBACK");throw error; }
}
