import { DatabaseSync } from "node:sqlite";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { lineIsInsideArea } from "@/lib/graph/geometry";
import { packSourceSchema } from "@/lib/contracts/manifest";
import type { DataRelease } from "@/lib/contracts/releases";
import type { Coordinate } from "./types";
import { sameSourceContent } from "./source-metadata";
import { ACCESS_ENTRY_POLICY_VERSION } from "@/lib/contracts/access-policy";
import { footSegmentAccessState } from "./compiled-edges";

/** Adapt stored provenance without coercing malformed database values. */
export function readPreparedSources(db:DatabaseSync):DataRelease["sources"] {
  return db.prepare("SELECT * FROM sources ORDER BY id").all().map(row=>{
    const source=packSourceSchema.safeParse({id:row.id,authority:row.authority,dataset:row.dataset,version:row.version,retrievedAt:row.retrieved_at,url:row.url,license:row.license,contentHash:row.content_hash});
    if(!source.success) throw new Error(`Complete graph source differs: ${row.id}`);
    return source.data;
  });
}

/** A single disk-backed scan verifies complete graph consistency before any release is visible. */
export async function auditPreparedGraph(db:DatabaseSync, expected:Pick<DataRelease,"id"|"geometry"|"sources"> & {accessPolicyVersion?:string}, checkpoint:()=>Promise<void>, allowSourceSubset=false) {
  if(db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value!=="7") throw new Error("Prepared graph schema version differs");
  if(db.prepare("SELECT value FROM metadata WHERE key='releaseId'").get()?.value!==expected.id) throw new Error("Complete graph release identity differs from export inputs");
  const policy=db.prepare("SELECT value FROM metadata WHERE key='access_policy_version'").get()?.value;
  if(policy!==expected.accessPolicyVersion) throw new Error("Complete graph entrance policy differs from catalog");
  if(policy===ACCESS_ENTRY_POLICY_VERSION) {
    if(db.prepare("SELECT node_id FROM access_points GROUP BY node_id HAVING count(*)<>1 LIMIT 1").get()) throw new Error("Repeated prepared entrance node identity");
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entry_witnesses'").get()) throw new Error("Missing prepared entrance witnesses");
    let entranceWork=0;
    for(const row of db.prepare(`SELECT a.id,a.access_state,w.record FROM access_points a LEFT JOIN entry_witnesses w ON w.access_point_id=a.id ORDER BY a.id`).iterate()) {
      if(++entranceWork%1000===0) await checkpoint();
      let witness: Record<string,unknown>;
      try {witness=JSON.parse(String(row.record)) as Record<string,unknown>;} catch {throw new Error(`Missing prepared entrance witness: ${row.id}`);}
      if(!witness || !['interface','trailhead','parking'].includes(String(witness.kind)) ||
        typeof witness.rootNodeId!=='string' || !witness.rootNodeId || typeof witness.departurePhysicalId!=='string' || !witness.departurePhysicalId ||
        typeof witness.known!=='boolean' || witness.known!==(row.access_state==='public') || !['public','unknown'].includes(String(row.access_state))) {
        throw new Error(`Invalid prepared entrance witness: ${row.id}`);
      }
    }
  }
  if(db.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok" || db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Complete graph failed SQLite integrity audit");
  const sources=new Set(expected.sources.map(source=>source.id));
  const stored=readPreparedSources(db);
  if(!stored.length || (!allowSourceSubset && stored.length!==sources.size) || stored.some(row=>!sources.has(String(row.id)))) throw new Error("Complete graph source inventory differs");
  for(const source of expected.sources.filter(source=>!allowSourceSubset||stored.some(row=>row.id===source.id))) {
    const row=stored.find(row=>row.id===source.id);
    if(!row || !sameSourceContent(row,source) || (!allowSourceSubset&&row.retrievedAt!==source.retrievedAt)) throw new Error(`Complete graph source differs: ${source.id}`);
  }
  sources.clear();
  for(const row of stored) sources.add(String(row.id));
  if(db.prepare(`SELECT n.id FROM nodes n LEFT JOIN node_spatial s ON s.row_id=n.node_key
    WHERE s.row_id IS NULL OR s.min_lon>n.lon OR s.max_lon<n.lon OR s.min_lat>n.lat OR s.max_lat<n.lat LIMIT 1`).get()) throw new Error("Incomplete node spatial inventory");
  let work=0;
  const finite=(value:unknown)=>typeof value==="number"&&Number.isFinite(value);
  for(const node of db.prepare("SELECT id,node_key,lon,lat,elevation_m FROM nodes ORDER BY node_key").iterate()) {
    if(++work%1000===0) await checkpoint();
    if(!Number.isSafeInteger(node.node_key)||Number(node.node_key)<1||!finite(node.lon)||!finite(node.lat)||!finite(node.elevation_m)) throw new Error(`Missing node coordinates/elevation: ${node.id}`);
  }
  for(const access of db.prepare("SELECT id,source_refs,known_minimum_stem_m AS known,inclusive_minimum_stem_m AS inclusive FROM access_points ORDER BY id").iterate()) {
    if(++work%1000===0) await checkpoint();
    if((JSON.parse(String(access.source_refs)) as string[]).some(id=>!sources.has(id))) throw new Error(`Unknown access source: ${access.id}`);
    if([access.known,access.inclusive].some(value=>value!==null&&(!finite(value)||Number(value)<0)) || (access.known!==null&&(access.inclusive===null||Number(access.inclusive)>Number(access.known)))) throw new Error(`Invalid compact feasibility hints: ${access.id}`);
  }
  // This extension is optional so previously installed schema-7 packs remain
  // readable. Audit values and joins explicitly even if a malformed producer
  // omitted the writer's CHECK and foreign-key constraints.
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_entrance_families'").get()) {
    let family:string|undefined,profile:string|undefined,junction:string|undefined,state:string|undefined,members=0;
    const checkGroup=()=>{if(family!==undefined&&members<2)throw new Error(`Invalid entrance family cardinality: ${family}`);};
    for(const member of db.prepare(`SELECT f.*,a.id AS access_exists,a.access_state,n.id AS junction_exists
      FROM access_entrance_families f LEFT JOIN access_points a ON a.id=f.access_point_id
      LEFT JOIN nodes n ON n.id=f.junction_node_id ORDER BY f.profile,f.family_id,f.access_point_id`).iterate()) {
      if(++work%1000===0) await checkpoint();
      if(!['known','inclusive'].includes(String(member.profile)) || !/^entrance-family:[0-9a-f]{64}$/.test(String(member.family_id)) ||
        !member.access_exists || !member.junction_exists || !finite(member.approach_distance_m) || Number(member.approach_distance_m)<0 || Number(member.approach_distance_m)>250 ||
        (member.access_state!=='public'&&(member.profile!=='inclusive'||member.access_state!=='unknown'))) throw new Error(`Invalid entrance family member: ${member.access_point_id}`);
      if(family!==member.family_id||profile!==member.profile) {
        checkGroup();family=String(member.family_id);profile=String(member.profile);junction=String(member.junction_node_id);state=String(member.access_state);members=0;
      }
      if(junction!==member.junction_node_id||state!==member.access_state) throw new Error(`Inconsistent entrance family: ${family}`);
      members++;
    }
    checkGroup();
    if(db.prepare(`SELECT profile,access_point_id FROM access_entrance_families
      GROUP BY profile,access_point_id HAVING count(*)<>1 LIMIT 1`).get()) throw new Error("Repeated entrance family membership");
  }
  let prior:{key:number;from:string;to:string;length:number;gain:number;loss:number}|undefined;
  for(const edge of db.prepare(`SELECT e.*,s.min_lon AS spatial_w,s.max_lon AS spatial_e,s.min_lat AS spatial_s,s.max_lat AS spatial_n,a.lon AS a_lon,a.lat AS a_lat,a.elevation_m AS a_elevation,a.flags AS a_flags,b.lon AS b_lon,b.lat AS b_lat,b.elevation_m AS b_elevation,b.flags AS b_flags,p.geometry_hash,p.from_node_key,p.to_node_key,a.node_key AS a_key,b.node_key AS b_key
    FROM edges e LEFT JOIN edge_spatial s ON s.row_id=e.edge_key LEFT JOIN nodes a ON a.id=e.from_node LEFT JOIN nodes b ON b.id=e.to_node LEFT JOIN physical_edges p ON p.physical_edge_key=e.physical_edge_key ORDER BY e.physical_edge_key,e.edge_key`).iterate()) {
    if(++work%1000===0) await checkpoint();
    if(policy===ACCESS_ENTRY_POLICY_VERSION && footSegmentAccessState(edge.access_state as import("@/lib/graph/types").AccessState,
      [JSON.parse(String(edge.a_flags)) as string[],JSON.parse(String(edge.b_flags)) as string[]])!==edge.access_state)
      throw new Error(`Prepared edge bypasses endpoint foot passage: ${edge.id}`);
    const geometry=JSON.parse(String(edge.geometry)) as Coordinate[];
    if(!Number.isSafeInteger(edge.edge_key)||Number(edge.edge_key)<1||!Number.isSafeInteger(edge.physical_edge_key)||Number(edge.physical_edge_key)<1 ||
      [edge.spatial_w,edge.spatial_e,edge.spatial_s,edge.spatial_n].some(value=>!finite(value)) ||
      geometry.some(([lon,lat])=>lon<Number(edge.spatial_w)||lon>Number(edge.spatial_e)||lat<Number(edge.spatial_s)||lat>Number(edge.spatial_n))) throw new Error(`Incomplete edge spatial inventory: ${edge.id}`);
    const profile=JSON.parse(String(edge.elevation_profile)) as number[][];
    const equal=(a:unknown,b:unknown)=>finite(a)&&finite(b)&&Math.abs(Number(a)-Number(b))<=1e-6;
    if(edge.edge_class!=="trail" || !geometry.length || !lineIsInsideArea(geometry,expected.geometry) || !equal(geometry[0]?.[0],edge.a_lon)||!equal(geometry[0]?.[1],edge.a_lat)||!equal(geometry.at(-1)?.[0],edge.b_lon)||!equal(geometry.at(-1)?.[1],edge.b_lat)) throw new Error(`Invalid complete edge geometry/endpoints: ${edge.id}`);
    if([edge.length_m,edge.gain_m,edge.loss_m].some(value=>!finite(value)||Number(value)<0)||!finite(edge.max_elevation_m)||(edge.max_sustained_grade_pct!==null&&!finite(edge.max_sustained_grade_pct))||!Array.isArray(profile)||profile.length<2||!equal(profile[0]?.[0],0)||!equal(profile.at(-1)?.[0],edge.length_m)||!equal(profile[0]?.[1],edge.a_elevation)||!equal(profile.at(-1)?.[1],edge.b_elevation)||profile.some((point,index)=>!finite(point[0])||!finite(point[1])||(index>0&&point[0]!<profile[index-1]![0]!)||point[1]!>Number(edge.max_elevation_m)+1e-6)) throw new Error(`Invalid complete edge metrics/elevation: ${edge.id}`);
    const forward=canonicalTopologyJson(geometry),reverse=canonicalTopologyJson([...geometry].reverse());
    if(topologySha256(forward<reverse?forward:reverse)!==edge.geometry_hash || Math.min(Number(edge.a_key),Number(edge.b_key))!==edge.from_node_key || Math.max(Number(edge.a_key),Number(edge.b_key))!==edge.to_node_key) throw new Error(`Inconsistent physical edge: ${edge.id}`);
    if((JSON.parse(String(edge.source_refs)) as string[]).some(id=>!sources.has(id))) throw new Error(`Unknown edge source: ${edge.id}`);
    if(prior?.key===edge.physical_edge_key) {
      const same=prior.from===edge.from_node&&prior.to===edge.to_node;
      if(!equal(prior.length,edge.length_m)||!equal(same?prior.gain:prior.loss,edge.gain_m)||!equal(same?prior.loss:prior.gain,edge.loss_m)) throw new Error(`Inconsistent physical edge metrics/directions: ${edge.id}`);
    }
    prior={key:Number(edge.physical_edge_key),from:String(edge.from_node),to:String(edge.to_node),length:Number(edge.length_m),gain:Number(edge.gain_m),loss:Number(edge.loss_m)};
  }
  await checkpoint();
}
