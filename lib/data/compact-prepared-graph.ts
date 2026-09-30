import { DatabaseSync } from "node:sqlite";
import { topologySha256, canonicalTopologyJson } from "@/lib/graph/topology-hash";
import { maximumSustainedGradePct } from "./metrics";
import { stableGraphKey } from "./progressive/publish";
import { preparedEdgeBounds } from "./prepared-spatial-index";

type Link = { physical_edge_key: number; other: string };
type Direction = { id: string; from_node: string; to_node: string; signature: string; bytes: number; length_m: number };
type Edge = { id:string; edge_key:number; from_node:string; to_node:string; geometry:string; elevation_profile:string;
  length_m:number; gain_m:number; loss_m:number; max_elevation_m:number; access_state:string; edge_class:string; source_refs:string; flags:string };
type MemberDirection = Pick<Direction,"id"|"from_node"|"bytes">;
type Member = { key:number; from:string; to:string; directions:MemberDirection[] };
const MAX_CORRIDOR_EDGES = 2048;
const MAX_CORRIDOR_BYTES = 8 * 1024 * 1024;

/**
 * Persist tower/pillar simplification without changing samples or routing choices.
 * https://github.com/graphhopper/graphhopper/blob/master/docs/core/low-level-api.md
 * Unlike ring-removing simplifiers, retain two anchors on an otherwise closed chain.
 * SQL holds adjacency/visited state; JS holds only one bounded corridor at a time.
 */
export async function compactPreparedGraph(db:DatabaseSync, checkpoint:()=>Promise<void>, {spatialIndexes=true}:{spatialIndexes?:boolean}={}) {
  if (db.isTransaction) throw new Error("Graph compaction requires no active transaction");
  if (!spatialIndexes && (db.prepare("SELECT 1 FROM node_spatial LIMIT 1").get() || db.prepare("SELECT 1 FROM edge_spatial LIMIT 1").get()))
    throw new Error("Deferred graph compaction requires empty spatial indexes");
  const counts = () => ({nodes:Number(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n),
    physicalEdges:Number(db.prepare("SELECT count(*) AS n FROM physical_edges").get()!.n)});
  const before = counts();
  await checkpoint();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TEMP TABLE compact_links(node TEXT NOT NULL,k INTEGER NOT NULL,other TEXT NOT NULL,PRIMARY KEY(node,k)) WITHOUT ROWID;
      INSERT INTO compact_links SELECT a.id,p.physical_edge_key,b.id FROM physical_edges p JOIN nodes a ON a.node_key=p.from_node_key JOIN nodes b ON b.node_key=p.to_node_key;
      INSERT OR IGNORE INTO compact_links SELECT b.id,p.physical_edge_key,a.id FROM physical_edges p JOIN nodes a ON a.node_key=p.from_node_key JOIN nodes b ON b.node_key=p.to_node_key;
      CREATE TEMP TABLE compact_directions AS SELECT id,edge_key,physical_edge_key,from_node,to_node,length_m,
        length(geometry)+length(elevation_profile) AS bytes,json_array(access_state,edge_class,source_refs,flags) AS signature FROM edges;
      CREATE INDEX compact_direction_physical ON compact_directions(physical_edge_key,id);
      CREATE TEMP TABLE compact_anchors(id TEXT PRIMARY KEY,done INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE INDEX compact_anchor_pending ON compact_anchors(done,id);
      INSERT OR IGNORE INTO compact_anchors(id) SELECT node_id FROM access_points;
      INSERT OR IGNORE INTO compact_anchors(id) SELECT n.id FROM nodes n LEFT JOIN compact_links l ON l.node=n.id
        GROUP BY n.id HAVING count(l.k)<>2 OR n.flags<>'[]' OR max(l.other=n.id);
      CREATE TEMP TABLE compact_remaining(k INTEGER PRIMARY KEY,node TEXT NOT NULL) STRICT;
      CREATE INDEX compact_remaining_node ON compact_remaining(node,k);
      INSERT INTO compact_remaining SELECT p.physical_edge_key,n.id FROM physical_edges p JOIN nodes n ON n.node_key=p.from_node_key;`);
    const links = db.prepare("SELECT k AS physical_edge_key,other FROM compact_links WHERE node=? ORDER BY k");
    const anchorLinks = db.prepare("SELECT k AS physical_edge_key,other FROM compact_links WHERE node=? ORDER BY k");
    const directions = db.prepare("SELECT * FROM compact_directions WHERE physical_edge_key=? ORDER BY id LIMIT 3");
    const anchor = db.prepare("INSERT OR IGNORE INTO compact_anchors(id) VALUES(?)");
    const isAnchor = db.prepare("SELECT 1 FROM compact_anchors WHERE id=?");
    let work = 0;
    // Metadata and one-way changes stay as real routing endpoints. A continuation
    // must exist in both matching directions or in exactly the same single direction.
    for (const row of db.prepare("SELECT id FROM nodes WHERE id NOT IN (SELECT id FROM compact_anchors) ORDER BY id").iterate()) {
      if (++work % 1000 === 0) await checkpoint();
      const id = String(row.id), pair = links.all(id) as Link[];
      const first = directions.all(pair[0]!.physical_edge_key) as Direction[];
      const second = directions.all(pair[1]!.physical_edge_key) as Direction[];
      const compatible = (a:Direction[], b:Direction[]) => a.length>0 && a.length<=2 && a.every(edge => edge.length_m>0 &&
        b.filter(next => (edge.to_node===id ? next.from_node===id : next.to_node===id) && edge.signature===next.signature && next.length_m>0).length===1);
      if (!compatible(first,second) || !compatible(second,first)) anchor.run(id);
    }
    // Retain only the direction IDs needed by this bounded corridor; signatures
    // stay in SQLite after compatibility checks, and no graph-wide cache grows.
    const memberDirections = db.prepare("SELECT id,from_node,bytes FROM compact_directions WHERE physical_edge_key=? ORDER BY id LIMIT 3");
    const unvisited = db.prepare("SELECT 1 FROM compact_remaining WHERE k=?");
    const mark = db.prepare("DELETE FROM compact_remaining WHERE k=?");
    const edge = db.prepare("SELECT * FROM edges WHERE id=?");
    const physical = db.prepare("SELECT stable_physical_id FROM physical_edges WHERE physical_edge_key=?");
    const nodeKey = db.prepare("SELECT node_key FROM nodes WHERE id=?");
    const insertPhysical = db.prepare("INSERT INTO physical_edges VALUES(?,?,?,?,?)");
    const insertEdge = db.prepare("INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertSpatial = spatialIndexes?db.prepare("INSERT INTO edge_spatial VALUES(?,?,?,?,?)"):undefined;
    const removeSpatial = spatialIndexes?db.prepare("DELETE FROM edge_spatial WHERE row_id IN (SELECT edge_key FROM compact_directions WHERE physical_edge_key=?)"):undefined;
    const removeEdges = db.prepare("DELETE FROM edges WHERE id IN (SELECT id FROM compact_directions WHERE physical_edge_key=?)");
    const removePhysical = db.prepare("DELETE FROM physical_edges WHERE physical_edge_key=?");
    const merge = async (chain:Member[]) => {
      if (chain.length<2) return;
      const ids=chain.map(({key})=>String(physical.get(key)!.stable_physical_id));
      const forwardId=JSON.stringify(ids),reverseId=JSON.stringify([...ids].reverse());
      const id=`corridor:${topologySha256(forwardId<reverseId?forwardId:reverseId).slice(7)}`;
      const key=stableGraphKey("physical",id);
      const first=chain[0]!,last=chain.at(-1)!;
      let inserted=false;
      for (const reverse of [false,true]) {
        const members=reverse?[...chain].reverse().map(item=>({...item,from:item.to,to:item.from})):chain;
        const initial=members[0]!.directions.find(item=>item.from_node===members[0]!.from);
        if(!initial) continue;
        let length=0,gain=0,loss=0,maximum=-Infinity;
        const geometry:Array<[number,number]>=[],profile:Array<{distanceMeters:number;elevationMeters:number}>=[];
        let metadata:Edge|undefined;
        for(const member of members) {
          if (++work%1000===0) await checkpoint();
          const selected=member.directions.find(item=>item.from_node===member.from);
          if(!selected) throw new Error("Compact corridor lost a directed continuation");
          const item=edge.get(selected.id) as Edge;
          metadata??=item;
          const points=JSON.parse(item.geometry) as Array<[number,number]>;
          const samples=JSON.parse(item.elevation_profile) as Array<[number,number]>;
          for(let index=geometry.length?1:0;index<points.length;index++) geometry.push(points[index]!);
          for(let index=profile.length?1:0;index<samples.length;index++) profile.push({distanceMeters:length+samples[index]![0],elevationMeters:samples[index]![1]});
          length+=item.length_m;gain+=item.gain_m;loss+=item.loss_m;maximum=Math.max(maximum,item.max_elevation_m);
        }
        if(!inserted) {
          const a=Number(nodeKey.get(first.from)!.node_key),b=Number(nodeKey.get(last.to)!.node_key);
          const geo=canonicalTopologyJson(geometry),back=canonicalTopologyJson([...geometry].reverse());
          insertPhysical.run(key,id,Math.min(a,b),Math.max(a,b),topologySha256(geo<back?geo:back));
          inserted=true;
        }
        const edgeId=`${id}:${reverse?"reverse":"forward"}`,edgeKey=stableGraphKey("edge",edgeId);
        insertEdge.run(edgeId,edgeKey,key,members[0]!.from,members.at(-1)!.to,JSON.stringify(geometry),length,gain,loss,maximum,
          maximumSustainedGradePct(profile),JSON.stringify(profile.map(({distanceMeters,elevationMeters})=>[distanceMeters,elevationMeters])),
          metadata!.access_state,metadata!.edge_class,metadata!.source_refs,metadata!.flags);
        if (insertSpatial) insertSpatial.run(edgeKey,...preparedEdgeBounds(geometry));
      }
      for(const member of chain){removeSpatial?.run(member.key);removeEdges.run(member.key);removePhysical.run(member.key);}
    };
    const pending=db.prepare("SELECT id FROM compact_anchors WHERE done=0 ORDER BY id LIMIT 1");
    const complete=db.prepare("UPDATE compact_anchors SET done=1 WHERE id=?");
    const remaining=db.prepare("SELECT node FROM compact_remaining ORDER BY node,k LIMIT 1");
    for(;;) {
      let start=pending.get();
      if(!start) { const ring=remaining.get();if(!ring)break;anchor.run(String(ring.node));start=pending.get(); }
      const id=String(start!.id);complete.run(id);
      for(const first of anchorLinks.iterate(id) as Iterable<Link>) {
        if(!unvisited.get(first.physical_edge_key))continue;
        const chain:Member[]=[];let from=id,link=first,bytes=0;
        let currentDirections=memberDirections.all(link.physical_edge_key) as MemberDirection[];
        for(;;) {
          if(++work%1000===0)await checkpoint();
          mark.run(link.physical_edge_key);chain.push({key:link.physical_edge_key,from,to:link.other,directions:currentDirections});
          bytes+=currentDirections.reduce((sum,item)=>sum+item.bytes,0);
          const to=link.other;
          if(isAnchor.get(to))break;
          const next=(links.all(to) as Link[]).find(item=>item.physical_edge_key!==link.physical_edge_key)!;
          const nextDirections=memberDirections.all(next.physical_edge_key) as MemberDirection[];
          const nextBytes=nextDirections.reduce((sum,item)=>sum+item.bytes,0);
          if(next.other===id || chain.length>=MAX_CORRIDOR_EDGES || bytes+nextBytes>MAX_CORRIDOR_BYTES) {anchor.run(to);break;}
          from=to;link=next;currentDirections=nextDirections;
        }
        await merge(chain);
      }
    }
    if (spatialIndexes) db.exec("DELETE FROM node_spatial WHERE row_id IN (SELECT node_key FROM nodes WHERE id NOT IN (SELECT id FROM compact_anchors));");
    db.exec("DELETE FROM nodes WHERE id NOT IN (SELECT id FROM compact_anchors);");
    await checkpoint();
    const after=counts();
    db.exec("COMMIT");
    return {beforeNodes:before.nodes,beforePhysicalEdges:before.physicalEdges,...after};
  } catch(error) {
    if(db.isTransaction)db.exec("ROLLBACK");
    throw error;
  } finally {
    for(const name of ["compact_links","compact_directions","compact_anchors","compact_remaining"])db.exec(`DROP TABLE IF EXISTS temp.${name}`);
  }
}
