import { DatabaseSync, type StatementSync } from "node:sqlite";
import { topologySha256 } from "@/lib/graph/topology-hash";
import type { AreaGeometry } from "../area-geometry";
import type { NormalizedAccessPoint, NormalizedNode, NormalizedPortalEvidence } from "../types";
import type { ProgressiveGraphStore } from "./store";
import { selectProgressiveEdges } from "./publish";
import { ConnectedEntryProof, type PreparedEntry } from "./entry-proof";

type Row=Record<string,string|number|null>;
const statementCaches=new WeakMap<DatabaseSync,Map<string,StatementSync>>();
const activeCursors=new WeakSet<StatementSync>();
function statement(db:DatabaseSync,sql:string):StatementSync {
  const cache=statementCaches.get(db)!;
  let prepared=cache.get(sql);
  if(!prepared){prepared=db.prepare(sql);cache.set(sql,prepared);}
  // A nested cursor must not reset the cached statement's active iteration.
  if(activeCursors.has(prepared))return db.prepare(sql);
  return prepared;
}
const one=(db:DatabaseSync,sql:string,...args:Array<string|number>)=>statement(db,sql).get(...args) as Row|undefined;
function* rows(db:DatabaseSync,sql:string,...args:Array<string|number>):Generator<Row> {
  const prepared=statement(db,sql);
  activeCursors.add(prepared);
  try {yield* prepared.iterate(...args) as Iterable<Row>;}
  finally {activeCursors.delete(prepared);}
}
const run=(db:DatabaseSync,sql:string,...args:Array<string|number|null>)=>statement(db,sql).run(...args);

/** SQLite-backed union-find; source-wide components and clusters occupy disk, not JS maps. */
export class DiskUnion {
  private readonly getParent;
  private readonly setParent;
  private readonly getRank;
  private readonly increaseRank;
  constructor(db:DatabaseSync,table:string) {
    this.getParent=db.prepare(`SELECT parent FROM ${table} WHERE id=?`);
    this.setParent=db.prepare(`UPDATE ${table} SET parent=? WHERE id=?`);
    this.getRank=db.prepare(`SELECT rank FROM ${table} WHERE id=?`);
    this.increaseRank=db.prepare(`UPDATE ${table} SET rank=rank+1 WHERE id=?`);
  }
  find(id:string):string {
    let root=id;const path:string[]=[];
    for(;;){const row=this.getParent.get(root) as {parent:string}|undefined;if(!row)throw new Error(`Unknown union node ${root}`);if(row.parent===root)break;path.push(root);root=row.parent;}
    // Union by rank bounds this temporary path. Its last node already points
    // at the root; update only deeper nodes without rereading their parents.
    for(let index=0;index<path.length-1;index++)this.setParent.run(root,path[index]!);
    return root;
  }
  union(a:string,b:string):void {
    let first=this.find(a),second=this.find(b);if(first===second)return;
    const aRank=Number((this.getRank.get(first) as {rank:number}).rank),bRank=Number((this.getRank.get(second) as {rank:number}).rank);
    if(aRank<bRank || (aRank===bRank && first>second)) [first,second]=[second,first];
    this.setParent.run(first,second);
    if(aRank===bRank)this.increaseRank.run(first);
  }
}

function ranking(db:DatabaseSync,nodeId:string,profile:"known"|"inclusive",reuseInclusive:boolean):{connectivity:number;outDegree:number} {
  const table=profile==="inclusive"&&reuseInclusive?"portal_components":`rank_${profile}`;
  const root=one(db,`SELECT parent FROM ${table} WHERE id=?`,nodeId);
  if(!root)return {connectivity:0,outDegree:0};
  // Component construction compresses every parent before ranking.
  const count=one(db,"SELECT n FROM portal_component_counts WHERE profile=? AND parent=?",
    profile==="inclusive"&&reuseInclusive?"all":profile,String(root.parent));
  const condition=profile==="known"?"e.access_state='public'":"e.access_state IN ('public','unknown')";
  const out=one(db,`SELECT count(*) AS n FROM edges e JOIN selected_edges s ON s.id=e.id WHERE e.from_node=? AND ${condition}`,nodeId);
  const incident=one(db,`SELECT 1 AS n FROM edges e JOIN selected_edges s ON s.id=e.id WHERE (e.from_node=? OR e.to_node=?) AND ${condition} LIMIT 1`,nodeId,nodeId);
  return {connectivity:incident?Number(count?.n??0):0,outDegree:Number(out?.n??0)};
}
async function rankComponents(db:DatabaseSync,profile:"known"|"inclusive",checkpoint:()=>Promise<void>):Promise<void> {
  let work=0;
  await checkpoint();
  db.exec(`CREATE TEMP TABLE rank_${profile}(id TEXT PRIMARY KEY,parent TEXT NOT NULL,rank INTEGER NOT NULL DEFAULT 0) STRICT;
    INSERT INTO rank_${profile}(id,parent) SELECT id,id FROM portal_components;
    CREATE INDEX rank_${profile}_parent ON rank_${profile}(parent);`);
  const union=new DiskUnion(db,`rank_${profile}`);
  const condition=profile==="known"?"e.access_state='public'":"e.access_state IN ('public','unknown')";
  // Connectivity is undirected: one selected direction suffices per physical link.
  for(const edge of rows(db,`SELECT e.from_node,e.to_node FROM edges e JOIN selected_edges s ON s.id=e.id WHERE ${condition} GROUP BY e.stable_physical_id`))
    { if (++work%1000===0) await checkpoint(); union.union(String(edge.from_node),String(edge.to_node)); }
  for(const row of rows(db,`SELECT id FROM rank_${profile}`)) { if (++work%1000===0) await checkpoint(); union.find(String(row.id)); }
  // Aggregate once per profile, not once per trailhead in the same component.
  run(db,`INSERT INTO portal_component_counts SELECT ?,parent,count(*) FROM rank_${profile} GROUP BY parent`,profile);
}

function candidateRecord(db:DatabaseSync,row:Row):NormalizedAccessPoint {
  const node=JSON.parse(String(row.record)) as NormalizedNode,witness=JSON.parse(String(row.witness)) as PreparedEntry;
  const evidence=[...rows(db,"SELECT e.record FROM portal_evidence p JOIN evidence e ON e.id=p.evidence_id WHERE p.node_id=? ORDER BY e.id",node.id)]
    .map(({record})=>JSON.parse(String(record)) as NormalizedPortalEvidence);
  const named=evidence.find(item=>item.kind==="trailhead"&&item.name?.trim())??evidence.find(item=>item.kind==="information"&&item.name?.trim())??evidence.find(item=>item.kind==="gate"&&item.name?.trim());
  const parking=evidence.find(item=>item.kind==="parking");
  const {kind,rootNodeId,departurePhysicalId,known}=witness;
  return {id:`portal:${node.id}`,externalId:node.externalId,nodeId:node.id,name:named?.name??(witness.name?`${witness.name} trailhead`:"Trailhead"),kind:"trailhead",accessState:known?"public":"unknown",
    confidence:evidence.some(item=>item.kind==="trailhead")?"high":evidence.length?"medium":"low",parkingEvidence:parking?`portal-evidence:${parking.externalId}`:null,
    sourceRefs:[...new Set([...node.sourceRefs,...witness.sourceRefs,...evidence.flatMap(item=>item.sourceRefs)])].sort(),entryWitness:{kind,rootNodeId,departurePhysicalId,known},
    portalRoadClass:String(row.road_class) as "street"|"service-road",parkingDistanceM:parking?0:null};
}

/** Freeze sparse local starts before distance pruning and expensive DEM work.
 * These records retain parking nominations even if another start's graph is pruned.
 * Complete ranking is attached once, from the final measured topology.
 */
export async function prepareSparsePortalCandidates(store:ProgressiveGraphStore,startGeometry:AreaGeometry,checkpoint:()=>Promise<void>=async()=>{}):Promise<{candidateAccessPoints:number;eligibleAccessPoints:number}> {
  const db=store.database;
  if(statementCaches.has(db))throw new Error("Portal derivation is already running");
  statementCaches.set(db,new Map());
  let complete=false;
  const proof=new ConnectedEntryProof(db,checkpoint);
  try {
    db.exec("DROP TABLE IF EXISTS temp.sparse_start_nodes; DROP TABLE IF EXISTS temp.sparse_portal_candidates; DROP TABLE IF EXISTS temp.portal_candidate_audit;");
    await checkpoint();
    await proof.prepare("sparse");
    await proof.discover(startGeometry);
    let work=0;
    db.exec(`CREATE TEMP TABLE sparse_start_nodes(node_id TEXT PRIMARY KEY) STRICT;
      CREATE TEMP TABLE sparse_portal_candidates(node_id TEXT PRIMARY KEY,record TEXT NOT NULL,witness TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE portal_candidate_audit(node_id TEXT PRIMARY KEY,access_state TEXT NOT NULL) STRICT;`);
    let candidateAccessPoints=0,eligibleAccessPoints=0;
    for(const row of rows(db,"SELECT c.node_id,c.road_class,c.witness,n.record FROM portal_candidates c JOIN nodes n ON n.id=c.node_id ORDER BY c.node_id")) {
      if(++work%1000===0)await checkpoint();
      candidateAccessPoints++;
      const point=candidateRecord(db,row);
      run(db,"INSERT INTO portal_candidate_audit VALUES (?,?)",point.nodeId,point.accessState);
      run(db,"INSERT INTO sparse_start_nodes VALUES (?)",point.nodeId);
      run(db,"INSERT INTO sparse_portal_candidates VALUES (?,?,?)",point.nodeId,JSON.stringify(point),String(row.witness));
      eligibleAccessPoints++;
    }
    await checkpoint();
    complete=true;
    return {candidateAccessPoints,eligibleAccessPoints};
  } finally {
    proof.clear();
    if(!complete)db.exec("DROP TABLE IF EXISTS temp.sparse_start_nodes; DROP TABLE IF EXISTS temp.sparse_portal_candidates; DROP TABLE IF EXISTS temp.portal_candidate_audit;");
    statementCaches.delete(db);
  }
}

/** Derive all portals against one installed exact union; recomputation is safe after interrupted imports. */
export async function deriveProgressivePortals(store:ProgressiveGraphStore,coverage:AreaGeometry,checkpoint:()=>Promise<void>=async()=>{}):Promise<number> {
  let work=0;
  await checkpoint();
  const db=store.database,coverageHash=topologySha256(coverage);
  if(statementCaches.has(db))throw new Error("Portal derivation is already running");
  statementCaches.set(db,new Map());
  const proof=new ConnectedEntryProof(db,checkpoint);
  try {
  await selectProgressiveEdges(store,coverage,checkpoint);
  if (!one(db,"SELECT 1 FROM selected_edges LIMIT 1")) {
    run(db,"DELETE FROM derived_portals WHERE coverage_hash=?",coverageHash);
    return 0;
  }
  db.exec(`DROP TABLE IF EXISTS temp.portal_components; CREATE TEMP TABLE portal_components(id TEXT PRIMARY KEY,parent TEXT NOT NULL,rank INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE INDEX portal_component_parent ON portal_components(parent);
    INSERT INTO portal_components(id,parent) SELECT from_node,from_node FROM edges WHERE id IN (SELECT id FROM selected_edges) UNION SELECT to_node,to_node FROM edges WHERE id IN (SELECT id FROM selected_edges);
    DROP TABLE IF EXISTS temp.trail_links; CREATE TEMP TABLE trail_links(physical_id TEXT PRIMARY KEY,a TEXT NOT NULL,b TEXT NOT NULL,length_m REAL NOT NULL) STRICT;`);
  for(const edge of rows(db,"SELECT stable_physical_id,record FROM edges WHERE id IN (SELECT id FROM selected_edges) GROUP BY stable_physical_id ORDER BY stable_physical_id")) {
    if (++work%1000===0) await checkpoint();
    const item=JSON.parse(String(edge.record)) as {fromNode:string;toNode:string;lengthM:number};
    run(db,"INSERT INTO trail_links VALUES (?,?,?,?)",String(edge.stable_physical_id),item.fromNode,item.toNode,item.lengthM);
  }
  const union=new DiskUnion(db,"portal_components");
  for(const edge of rows(db,"SELECT a,b FROM trail_links")) { if (++work%1000===0) await checkpoint(); union.union(String(edge.a),String(edge.b)); }
  db.exec(`CREATE TEMP TABLE component_stats(root TEXT PRIMARY KEY,min_id TEXT NOT NULL,length_m REAL NOT NULL DEFAULT 0) STRICT;
    CREATE TEMP TABLE portal_component_counts(profile TEXT NOT NULL,parent TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(profile,parent)) WITHOUT ROWID;`);
  for(const row of rows(db,"SELECT id FROM portal_components ORDER BY id")) {
    if (++work%1000===0) await checkpoint();
    const id=String(row.id),root=union.find(id);
    run(db,"INSERT INTO component_stats(root,min_id,length_m) VALUES (?,?,0) ON CONFLICT(root) DO UPDATE SET min_id=min(min_id,excluded.min_id)",root,id);
  }
  run(db,"INSERT INTO portal_component_counts SELECT 'all',parent,count(*) FROM portal_components GROUP BY parent");
  for(const row of rows(db,"SELECT a,length_m FROM trail_links")) { if (++work%1000===0) await checkpoint(); run(db,"UPDATE component_stats SET length_m=length_m+? WHERE root=?",Number(row.length_m),union.find(String(row.a))); }
  const reuseInclusive=!one(db,`SELECT 1 FROM edges e JOIN selected_edges s ON s.id=e.id WHERE e.access_state NOT IN ('public','unknown') LIMIT 1`);
  await rankComponents(db,"known",checkpoint);
  if(!reuseInclusive)await rankComponents(db,"inclusive",checkpoint);
  const prepared=Boolean(one(db,"SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='sparse_portal_candidates'"));
  await proof.prepare("measured",!prepared);
  if(!prepared) await proof.discover(coverage);
  run(db,"DELETE FROM derived_portals WHERE coverage_hash=?",coverageHash);
  let count=0;
  const candidates=prepared
    ? rows(db,"SELECT record,witness FROM sparse_portal_candidates ORDER BY node_id")
    : rows(db,"SELECT c.node_id,c.road_class,c.witness,n.record FROM portal_candidates c JOIN nodes n ON n.id=c.node_id ORDER BY c.node_id");
  for(const row of candidates) {
    if(++work%1000===0)await checkpoint();
    const point=prepared?JSON.parse(String(row.record)) as NormalizedAccessPoint:candidateRecord(db,row);
    if(!one(db,"SELECT 1 FROM portal_components WHERE id=?",point.nodeId))continue;
    if(prepared && point.entryWitness) {
      const finalWitness=proof.refresh(point.nodeId,JSON.parse(String(row.witness)) as PreparedEntry);
      if(!finalWitness)continue;
      point.entryWitness={...point.entryWitness,departurePhysicalId:finalWitness.departurePhysicalId};
    }
    const component=one(db,"SELECT min_id,length_m FROM component_stats WHERE root=?",union.find(point.nodeId))!;
    const known=ranking(db,point.nodeId,"known",reuseInclusive),inclusive=ranking(db,point.nodeId,"inclusive",reuseInclusive);
    Object.assign(point,{knownConnectivity:known.connectivity,inclusiveConnectivity:inclusive.connectivity,knownOutDegree:known.outDegree,inclusiveOutDegree:inclusive.outDegree,
      reachableTrailKm:Number(component.length_m)/1000,trailComponentId:`trail-component:${component.min_id}`});
    run(db,"INSERT INTO derived_portals VALUES (?,?,?,?)",coverageHash,point.id,point.nodeId,JSON.stringify(point));count++;
  }
  await checkpoint();
  return count;
  } finally {
    statementCaches.delete(db);
    proof.clear();
    for (const table of ["rank_known","rank_inclusive","component_stats","portal_component_counts","trail_links","portal_components"]) db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}
