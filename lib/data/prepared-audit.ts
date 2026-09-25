import { DatabaseSync } from "node:sqlite";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { lineIsInsideArea } from "@/lib/graph/geometry";
import type { DataRelease } from "@/lib/contracts/releases";
import type { Coordinate } from "./types";

/** A single disk-backed scan verifies complete graph consistency before any release is visible. */
export async function auditPreparedGraph(db:DatabaseSync, expected:Pick<DataRelease,"id"|"geometry"|"sources">, checkpoint:()=>Promise<void>) {
  if(db.prepare("SELECT value FROM metadata WHERE key='releaseId'").get()?.value!==expected.id) throw new Error("Complete graph release identity differs from export inputs");
  if(db.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok" || db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Complete graph failed SQLite integrity audit");
  const sources=new Set(expected.sources.map(source=>source.id));
  const stored=db.prepare("SELECT * FROM sources ORDER BY id").all();
  if(stored.length!==sources.size) throw new Error("Complete graph source inventory differs");
  for(const source of expected.sources) {
    const row=stored.find(row=>row.id===source.id);
    if(!row || row.authority!==source.authority || row.dataset!==source.dataset || row.version!==source.version || row.retrieved_at!==source.retrievedAt || row.url!==source.url || row.license!==source.license || row.content_hash!==source.contentHash) throw new Error(`Complete graph source differs: ${source.id}`);
  }
  if(db.prepare(`SELECT n.id FROM nodes n LEFT JOIN node_spatial s ON s.row_id=n.node_key
    WHERE s.row_id IS NULL OR s.min_lon>n.lon OR s.max_lon<n.lon OR s.min_lat>n.lat OR s.max_lat<n.lat LIMIT 1`).get()) throw new Error("Incomplete node spatial inventory");
  let work=0;
  const finite=(value:unknown)=>typeof value==="number"&&Number.isFinite(value);
  for(const node of db.prepare("SELECT id,lon,lat,elevation_m FROM nodes ORDER BY node_key").iterate()) {
    if(++work%1000===0) await checkpoint();
    if(!finite(node.lon)||!finite(node.lat)||!finite(node.elevation_m)) throw new Error(`Missing node coordinates/elevation: ${node.id}`);
  }
  for(const access of db.prepare("SELECT id,known_minimum_stem_m AS known,inclusive_minimum_stem_m AS inclusive FROM access_points ORDER BY id").iterate()) {
    if(++work%1000===0) await checkpoint();
    if([access.known,access.inclusive].some(value=>value!==null&&(!finite(value)||Number(value)<0)) || (access.known!==null&&(access.inclusive===null||Number(access.inclusive)>Number(access.known)))) throw new Error(`Invalid compact feasibility hints: ${access.id}`);
  }
  let prior:{key:number;from:string;to:string;length:number;gain:number;loss:number}|undefined;
  for(const edge of db.prepare(`SELECT e.*,a.lon AS a_lon,a.lat AS a_lat,a.elevation_m AS a_elevation,b.lon AS b_lon,b.lat AS b_lat,b.elevation_m AS b_elevation,p.geometry_hash,p.from_node_key,p.to_node_key,a.node_key AS a_key,b.node_key AS b_key
    FROM edges e LEFT JOIN nodes a ON a.id=e.from_node LEFT JOIN nodes b ON b.id=e.to_node LEFT JOIN physical_edges p ON p.physical_edge_key=e.physical_edge_key ORDER BY e.physical_edge_key,e.edge_key`).iterate()) {
    if(++work%1000===0) await checkpoint();
    const geometry=JSON.parse(String(edge.geometry)) as Coordinate[];
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
