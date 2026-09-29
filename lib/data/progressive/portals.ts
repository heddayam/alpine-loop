import { DatabaseSync, type StatementSync } from "node:sqlite";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { prepareAreaGeometry } from "@/lib/graph/geometry";
import { DistanceQueue } from "@/lib/graph/sqlite-records";
import type { AreaGeometry } from "../area-geometry";
import { densifyGeometry, distanceMeters } from "../metrics";
import { accessPointIsWildEnough, BUILDING_RADIUS_M } from "../wilderness";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";
import type { ProgressiveGraphStore } from "./store";
import { selectProgressiveEdges } from "./publish";

const EARTH_RADIUS_M=6_371_008.8;
const restricted="'private','closed','prohibited'";
type Row=Record<string,string|number|null>;
const statementCaches=new WeakMap<DatabaseSync,Map<string,StatementSync>>();
function statement(db:DatabaseSync,sql:string):StatementSync {
  const cache=statementCaches.get(db)!;
  let prepared=cache.get(sql);
  if(!prepared){prepared=db.prepare(sql);cache.set(sql,prepared);}
  return prepared;
}
const one=(db:DatabaseSync,sql:string,...args:Array<string|number>)=>statement(db,sql).get(...args) as Row|undefined;
const rows=(db:DatabaseSync,sql:string,...args:Array<string|number>)=>db.prepare(sql).iterate(...args) as Iterable<Row>;
const run=(db:DatabaseSync,sql:string,...args:Array<string|number|null>)=>statement(db,sql).run(...args);
function distance(a:readonly [number,number],b:readonly [number,number]):number {
  const radians=Math.PI/180,deltaLat=(b[1]-a[1])*radians,deltaLon=(b[0]-a[0])*radians;
  const x=Math.sin(deltaLat/2)**2+Math.cos(a[1]*radians)*Math.cos(b[1]*radians)*Math.sin(deltaLon/2)**2;
  return 2*EARTH_RADIUS_M*Math.asin(Math.min(1,Math.sqrt(x)));
}
function box(lon:number,lat:number,radius:number):[number,number,number,number] {
  const dy=radius/111_000,dx=radius/(111_000*Math.max(0.05,Math.cos(lat*Math.PI/180)));
  return [lon-dx,lon+dx,lat-dy,lat+dy];
}

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
    let root=id;
    for(;;){const row=this.getParent.get(root) as {parent:string}|undefined;if(!row)throw new Error(`Unknown union node ${root}`);if(row.parent===root)break;root=row.parent;}
    let current=id;
    while(current!==root){const parent=(this.getParent.get(current) as {parent:string}).parent;if(parent===root)break;this.setParent.run(root,current);current=parent;}
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

async function nearbyBuildings(db:DatabaseSync,lon:number,lat:number,checkpoint:()=>Promise<void>):Promise<number> {
  let work=0;
  await checkpoint();
  const [minLon,maxLon,minLat,maxLat]=box(lon,lat,BUILDING_RADIUS_M);let count=0;
  for(const row of rows(db,`SELECT b.lon,b.lat FROM building_spatial s JOIN buildings b ON b.id=s.id
    WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?`,minLon,maxLon,minLat,maxLat))
    {
      if (++work%1000===0) await checkpoint();
      if(distance([lon,lat],[Number(row.lon),Number(row.lat)])<=BUILDING_RADIUS_M)count++;
    }
  return count;
}
function waysAt(db:DatabaseSync,nodeId:string):NormalizedWay[] {
  return [...rows(db,"SELECT DISTINCT w.record FROM ways w JOIN way_nodes x ON x.way_id=w.id WHERE x.node_id=? AND w.edge_class='trail' ORDER BY w.id",nodeId)]
    .map(({record})=>JSON.parse(String(record)) as NormalizedWay);
}
const allowedAccess=(item:{accessState:string})=>item.accessState==="public"||item.accessState==="unknown";
const trackWay=(way:NormalizedWay)=>way.flags.includes("osm-highway:track");
const hikingWay=(way:Pick<NormalizedWay,"flags">)=>way.flags.some(flag=>flag.startsWith("osm-highway:")&&flag!=="osm-highway:track");
function selectedSegment(db:DatabaseSync,way:NormalizedWay,index:number):boolean {
  return Boolean(one(db,"SELECT 1 FROM portal_links WHERE physical_id=? AND allowed=1",`${way.id}:${index}`));
}
function selectedWayAt(db:DatabaseSync,way:NormalizedWay,nodeId:string):boolean {
  return way.nodeIds.some((id,index)=>id===nodeId && ((index>0&&selectedSegment(db,way,index-1)) || (index<way.nodeIds.length-1&&selectedSegment(db,way,index))));
}
/** Bounded Dijkstra follows the selected hiking topology across source-way splits.
 * Direction is irrelevant to association; route search still enforces direction.
 */
async function hasNearbyTrackApproach(db:DatabaseSync,nodeId:string,checkpoint:()=>Promise<void>):Promise<boolean> {
  const pending=new DistanceQueue(),distances=new Map([[nodeId,0]]);
  pending.push({nodeId,distance:0});
  while(pending.size) {
    await checkpoint();
    const current=pending.pop()!;
    if(current.distance!==distances.get(current.nodeId))continue;
    let hikingContact=false;
    for(const link of rows(db,`SELECT * FROM portal_links
      WHERE (from_node=? OR to_node=?) AND allowed=1 AND hiking=1`,current.nodeId,current.nodeId)) {
      hikingContact=true;
      let meters=Number(link.length_m);
      if(!Number.isFinite(meters)||meters<0)throw new Error(`Invalid hiking segment distance: ${link.physical_id}`);
      if(current.distance+meters>250)continue;
      // eligible_segments carries a conservative distance bound. Only nearby
      // approach links need the exact geometric length used by metric sampling.
      if(!Number(link.measured)) {
        const ends=one(db,`SELECT a.lon AS x,a.lat AS y,b.lon AS x2,b.lat AS y2 FROM nodes a,nodes b WHERE a.id=? AND b.id=?`,String(link.from_node),String(link.to_node));
        if(!ends)throw new Error(`Missing candidate link endpoint: ${link.physical_id}`);
        const geometry=densifyGeometry([[Number(ends.x),Number(ends.y)],[Number(ends.x2),Number(ends.y2)]]);
        meters=0;
        for(let index=1;index<geometry.length;index++)meters+=distanceMeters(geometry[index-1]!,geometry[index]!);
        run(db,"UPDATE portal_links SET length_m=?,measured=1 WHERE physical_id=?",meters,String(link.physical_id));
      }
      const next=String(link.from_node)===current.nodeId?String(link.to_node):String(link.from_node),length=current.distance+meters;
      if(length<=250&&length<(distances.get(next)??Infinity)) {
        distances.set(next,length);pending.push({nodeId:next,distance:length});
      }
    }
    if(hikingContact&&waysAt(db,current.nodeId).some(way=>allowedAccess(way)&&trackWay(way)))return true;
  }
  return false;
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

/** Candidate admission needs local links and context, not elevation or graph-wide ranking. */
function createPortalLinks(db:DatabaseSync):void {
  db.exec(`CREATE TEMP TABLE portal_links(physical_id TEXT PRIMARY KEY,from_node TEXT NOT NULL,to_node TEXT NOT NULL,length_m REAL NOT NULL,allowed INTEGER NOT NULL,hiking INTEGER NOT NULL,measured INTEGER NOT NULL) STRICT;
    CREATE INDEX portal_links_from ON portal_links(from_node);
    CREATE INDEX portal_links_to ON portal_links(to_node);`);
}
function indexPortalNodes(db:DatabaseSync):void {
  db.exec(`CREATE TEMP TABLE portal_trail_nodes(id TEXT PRIMARY KEY) STRICT;
    INSERT INTO portal_trail_nodes SELECT from_node FROM portal_links UNION SELECT to_node FROM portal_links;`);
}
async function linksFromMeasuredEdges(db:DatabaseSync,checkpoint:()=>Promise<void>):Promise<void> {
  createPortalLinks(db);
  let work=0;
  for(const row of rows(db,"SELECT e.record FROM edges e JOIN selected_edges s ON s.id=e.id ORDER BY e.id")) {
    if(++work%1000===0)await checkpoint();
    const edge=JSON.parse(String(row.record)) as CompiledEdge;
    run(db,`INSERT INTO portal_links VALUES (?,?,?,?,?,?,1) ON CONFLICT(physical_id) DO UPDATE SET
      allowed=max(allowed,excluded.allowed),hiking=max(hiking,excluded.hiking)`,edge.stablePhysicalId,edge.fromNode,edge.toNode,edge.lengthM,Number(allowedAccess(edge)),Number(hikingWay(edge)));
  }
  indexPortalNodes(db);
}
async function discoverPortalCandidates(db:DatabaseSync,coverage:AreaGeometry,checkpoint:()=>Promise<void>):Promise<void> {
  let work=0;
  const boundary=prepareAreaGeometry(coverage);
  db.exec(`CREATE TEMP TABLE road_nodes(node_id TEXT PRIMARY KEY,road_class TEXT NOT NULL) STRICT;
    INSERT INTO road_nodes SELECT x.node_id,CASE WHEN max(w.edge_class='street') THEN 'street' ELSE 'service-road' END
    FROM way_nodes x JOIN ways w ON w.id=x.way_id WHERE w.edge_class IN ('street','service-road') AND w.access_state NOT IN (${restricted}) GROUP BY x.node_id;
    CREATE TEMP TABLE portal_candidates(node_id TEXT PRIMARY KEY,road_class TEXT NOT NULL) STRICT;
    CREATE TEMP TABLE portal_evidence(node_id TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(node_id,evidence_id)) WITHOUT ROWID;`);
  const addCandidate=(nodeId:string,roadClass:"street"|"service-road")=>{
    const prior=one(db,"SELECT road_class FROM portal_candidates WHERE node_id=?",nodeId);
    if(prior){if(roadClass==="street"&&prior.road_class!=="street")run(db,"UPDATE portal_candidates SET road_class='street' WHERE node_id=?",nodeId);return;}
    const nodeRow=one(db,"SELECT lon,lat FROM nodes WHERE id=?",nodeId);if(!nodeRow)return;
    if(!boundary.containsPoint([Number(nodeRow.lon),Number(nodeRow.lat)]))return;
    run(db,"INSERT INTO portal_candidates VALUES (?,?)",nodeId,roadClass);
  };
  // Names, confidence and entrance evidence belong to the actual mapped node.
  for(const row of rows(db,"SELECT id,record FROM evidence WHERE kind!='parking' ORDER BY id")) {
    if (++work%1000===0) await checkpoint();
    const item=JSON.parse(String(row.record)) as NormalizedPortalEvidence;
    if(!allowedAccess(item)||item.nodeIds.length!==1||!item.externalId.startsWith("node/"))continue;
    const nodeId=item.nodeIds[0]!,node=one(db,"SELECT n.record FROM nodes n JOIN portal_trail_nodes t ON t.id=n.id WHERE n.id=?",nodeId);
    if(!node||(JSON.parse(String(node.record)) as NormalizedNode).externalId!==item.externalId)continue;
    run(db,"INSERT INTO portal_evidence VALUES (?,?)",nodeId,String(row.id));
    // Trailheads can lie along the mapped hiking approach, beyond its junction.
    if(item.kind==="trailhead"&&await hasNearbyTrackApproach(db,nodeId,checkpoint))addCandidate(nodeId,"service-road");
  }
  for(const row of rows(db,"SELECT r.node_id,r.road_class FROM road_nodes r JOIN portal_trail_nodes t ON t.id=r.node_id ORDER BY r.node_id")) {
    if (++work%1000===0) await checkpoint();
    if(row.road_class==="street"||one(db,`SELECT 1 FROM portal_evidence p JOIN evidence e ON e.id=p.evidence_id
      WHERE p.node_id=? AND e.kind IN ('trailhead','gate') LIMIT 1`,String(row.node_id)))
      addCandidate(String(row.node_id),String(row.road_class) as "street"|"service-road");
  }
  // A parking feature nominates one of its own selected hiking contacts. Its
  // mapped road/track contact may be another vertex; no connector is invented.
  for(const evidenceRow of rows(db,"SELECT id,record FROM evidence WHERE kind='parking' ORDER BY id")) {
    if (++work%1000===0) await checkpoint();
    const item=JSON.parse(String(evidenceRow.record)) as NormalizedPortalEvidence;
    if(!allowedAccess(item))continue;
    const approaches:Array<{coordinates:readonly [number,number];roadClass:"street"|"service-road"}>=[];
    const trails:Array<{id:string;coordinates:readonly [number,number]}>=[];
    for(const nodeId of new Set(item.nodeIds)) {
      if (++work%1000===0) await checkpoint();
      const node=one(db,"SELECT lon,lat FROM nodes WHERE id=?",nodeId);if(!node)continue;
      const coordinates=[Number(node.lon),Number(node.lat)] as const,incident=waysAt(db,nodeId).filter(allowedAccess);
      const road=one(db,"SELECT road_class FROM road_nodes WHERE node_id=?",nodeId);
      if(road||incident.some(trackWay))approaches.push({coordinates,roadClass:road?.road_class==="street"?"street":"service-road"});
      if(incident.some(way=>hikingWay(way)&&selectedWayAt(db,way,nodeId)))trails.push({id:nodeId,coordinates});
    }
    if(!approaches.length)continue;
    const nomination=trails.map(trail=>({...trail,distance:Math.min(...approaches.map(approach=>distance(approach.coordinates,trail.coordinates)))}))
      .sort((a,b)=>a.distance-b.distance||a.id.localeCompare(b.id))[0];
    if(!nomination)continue;
    addCandidate(nomination.id,approaches.some(approach=>approach.roadClass==="street")?"street":"service-road");
    run(db,"INSERT INTO portal_evidence VALUES (?,?)",nomination.id,String(evidenceRow.id));
  }
}
async function candidateRecord(db:DatabaseSync,row:Row,checkpoint:()=>Promise<void>):Promise<NormalizedAccessPoint> {
    const node=JSON.parse(String(row.record)) as NormalizedNode,incident=waysAt(db,node.id);
    const evidence=[...rows(db,"SELECT e.record FROM portal_evidence p JOIN evidence e ON e.id=p.evidence_id WHERE p.node_id=? ORDER BY e.id",node.id)]
      .map(({record})=>JSON.parse(String(record)) as NormalizedPortalEvidence);
    const named=evidence.find(item=>item.kind==="trailhead"&&item.name?.trim())??evidence.find(item=>item.kind==="information"&&item.name?.trim())??evidence.find(item=>item.kind==="gate"&&item.name?.trim());
    const trailName=incident.map(({name})=>name?.trim()).filter((name):name is string=>!!name).sort()[0];
    const parking=evidence.find(item=>item.kind==="parking");
    const states=new Set(incident.map(({accessState})=>accessState));
    const accessState=( ["closed","prohibited","private","unknown","public"] as const).find((state)=>states.has(state))??"unknown";
    return {id:`portal:${node.id}`,externalId:node.externalId,nodeId:node.id,name:named?.name??(trailName?`${trailName} trailhead`:"Trailhead"),kind:"trailhead",accessState,
      confidence:evidence.some(item=>item.kind==="trailhead")?"high":evidence.length?"medium":"low",parkingEvidence:parking?`portal-evidence:${parking.externalId}`:null,
      sourceRefs:[...new Set([...node.sourceRefs,...incident.flatMap(({sourceRefs})=>sourceRefs),...evidence.flatMap(item=>item.sourceRefs)])].sort(),
      portalRoadClass:String(row.road_class) as "street"|"service-road",parkingDistanceM:parking?0:null,nearbyBuildingCount:await nearbyBuildings(db,node.lon,node.lat,checkpoint)};
}
const discoveryTables=["portal_evidence","portal_candidates","road_nodes","portal_trail_nodes","portal_links"];
function clearDiscovery(db:DatabaseSync):void {
  for(const table of discoveryTables)db.exec(`DROP TABLE IF EXISTS temp.${table}`);
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
  try {
    db.exec("DROP TABLE IF EXISTS temp.sparse_start_nodes; DROP TABLE IF EXISTS temp.sparse_portal_candidates; DROP TABLE IF EXISTS temp.portal_candidate_audit;");
    await checkpoint();
    createPortalLinks(db);
    let work=0,previousId="",way:NormalizedWay|undefined;
    for(const link of rows(db,"SELECT * FROM eligible_segments ORDER BY id")) {
      if(++work%1000===0)await checkpoint();
      const id=String(link.id),wayId=id.slice(0,id.lastIndexOf(":"));
      if(wayId!==previousId) {
        const record=one(db,"SELECT record FROM ways WHERE id=?",wayId);
        if(!record)throw new Error(`Unknown source way for candidate segment ${id}`);
        way=JSON.parse(String(record.record)) as NormalizedWay;previousId=wayId;
      }
      if(!way||way.edgeClass!=="trail"||!allowedAccess(way))continue;
      run(db,"INSERT INTO portal_links VALUES (?,?,?,?,?,?,0)",id,String(link.from_node),String(link.to_node),Number(link.length_m),1,Number(hikingWay(way)));
    }
    indexPortalNodes(db);
    await discoverPortalCandidates(db,startGeometry,checkpoint);
    db.exec(`CREATE TEMP TABLE sparse_start_nodes(node_id TEXT PRIMARY KEY) STRICT;
      CREATE TEMP TABLE sparse_portal_candidates(node_id TEXT PRIMARY KEY,record TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE portal_candidate_audit(node_id TEXT PRIMARY KEY,nearby_building_count INTEGER NOT NULL,access_state TEXT NOT NULL) STRICT;`);
    let candidateAccessPoints=0,eligibleAccessPoints=0;
    for(const row of rows(db,"SELECT c.node_id,c.road_class,n.record FROM portal_candidates c JOIN nodes n ON n.id=c.node_id ORDER BY c.node_id")) {
      if(++work%1000===0)await checkpoint();
      candidateAccessPoints++;
      const point=await candidateRecord(db,row,checkpoint);
      run(db,"INSERT INTO portal_candidate_audit VALUES (?,?,?)",point.nodeId,point.nearbyBuildingCount!,point.accessState);
      if(!allowedAccess(point)||!accessPointIsWildEnough({nearbyBuildingCount:point.nearbyBuildingCount!}))continue;
      run(db,"INSERT INTO sparse_start_nodes VALUES (?)",point.nodeId);
      run(db,"INSERT INTO sparse_portal_candidates VALUES (?,?)",point.nodeId,JSON.stringify(point));
      eligibleAccessPoints++;
    }
    await checkpoint();
    complete=true;
    return {candidateAccessPoints,eligibleAccessPoints};
  } finally {
    clearDiscovery(db);
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
  if(!prepared) {
    await linksFromMeasuredEdges(db,checkpoint);
    await discoverPortalCandidates(db,coverage,checkpoint);
  }
  run(db,"DELETE FROM derived_portals WHERE coverage_hash=?",coverageHash);
  let count=0;
  const candidates=prepared
    ? rows(db,"SELECT record FROM sparse_portal_candidates ORDER BY node_id")
    : rows(db,"SELECT c.node_id,c.road_class,n.record FROM portal_candidates c JOIN nodes n ON n.id=c.node_id ORDER BY c.node_id");
  for(const row of candidates) {
    if(++work%1000===0)await checkpoint();
    const point=prepared?JSON.parse(String(row.record)) as NormalizedAccessPoint:await candidateRecord(db,row,checkpoint);
    if(!one(db,"SELECT 1 FROM portal_components WHERE id=?",point.nodeId))continue;
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
    clearDiscovery(db);
    for (const table of ["rank_known","rank_inclusive","component_stats","portal_component_counts","trail_links","portal_components"]) db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}
