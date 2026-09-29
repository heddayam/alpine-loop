import { DatabaseSync, type StatementSync } from "node:sqlite";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import type { AreaGeometry } from "../area-geometry";
import { BUILDING_RADIUS_M } from "../wilderness";
import type { NormalizedAccessPoint, NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";
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
    while(current!==root){const parent=(this.getParent.get(current) as {parent:string}).parent;this.setParent.run(root,current);current=parent;}
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

async function evidenceNear(db:DatabaseSync,lon:number,lat:number,radius:number,checkpoint:()=>Promise<void>):Promise<Array<{item:NormalizedPortalEvidence;distanceM:number}>> {
  let work=0;
  await checkpoint();
  const [minLon,maxLon,minLat,maxLat]=box(lon,lat,radius);
  const nearest=new Map<string,{item:NormalizedPortalEvidence;distanceM:number}>();
  for(const row of rows(db,`SELECT e.record,p.lon,p.lat FROM evidence_spatial s JOIN evidence_points p ON p.id=s.id JOIN evidence e ON e.id=p.evidence_id
    WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?`,minLon,maxLon,minLat,maxLat)) {
    if (++work%1000===0) await checkpoint();
    const measured=distance([lon,lat],[Number(row.lon),Number(row.lat)]);
    if(measured>radius)continue;
    const item=JSON.parse(String(row.record)) as NormalizedPortalEvidence;
    const old=nearest.get(item.id);
    if(!old||measured<old.distanceM)nearest.set(item.id,{item,distanceM:measured});
  }
  return [...nearest.values()].sort((a,b)=>a.distanceM-b.distanceM||a.item.id.localeCompare(b.item.id));
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
const hikingWay=(way:NormalizedWay)=>way.flags.some(flag=>flag.startsWith("osm-highway:")&&flag!=="osm-highway:track");
function selectedSegment(db:DatabaseSync,way:NormalizedWay,index:number):boolean {
  return Boolean(one(db,`SELECT 1 FROM edges e JOIN selected_edges s ON s.id=e.id
    WHERE e.stable_physical_id=? AND e.access_state IN ('public','unknown') LIMIT 1`,`${way.id}:${index}`));
}
function selectedWayAt(db:DatabaseSync,way:NormalizedWay,nodeId:string):boolean {
  return way.nodeIds.some((id,index)=>id===nodeId && ((index>0&&selectedSegment(db,way,index-1)) || (index<way.nodeIds.length-1&&selectedSegment(db,way,index))));
}
/** Trailhead signs may sit along their trail, rather than on its road junction. */
async function hasNearbyTrackApproach(db:DatabaseSync,nodeId:string,checkpoint:()=>Promise<void>):Promise<boolean> {
  const hasTrack=(id:string)=>waysAt(db,id).some(way=>allowedAccess(way)&&trackWay(way));
  for(const way of waysAt(db,nodeId).filter(way=>allowedAccess(way)&&hikingWay(way))) {
    if(!selectedWayAt(db,way,nodeId))continue;
    if(hasTrack(nodeId))return true;
    for(let origin=0;origin<way.nodeIds.length;origin++) {
      if(way.nodeIds[origin]!==nodeId)continue;
      for(const direction of [-1,1]) {
        let length=0;
        for(let index=origin+direction;index>=0&&index<way.nodeIds.length;index+=direction) {
          await checkpoint();
          const previous=index-direction;
          length+=distance(way.coordinates[previous]!,way.coordinates[index]!);
          if(length>250||!selectedSegment(db,way,Math.min(previous,index)))break;
          if(hasTrack(way.nodeIds[index]!))return true;
        }
      }
    }
  }
  return false;
}
function ranking(db:DatabaseSync,nodeId:string,profile:"known"|"inclusive",reuseInclusive:boolean):{connectivity:number;outDegree:number} {
  const table=profile==="inclusive"&&reuseInclusive?"portal_components":`rank_${profile}`;
  const root=one(db,`SELECT parent FROM ${table} WHERE id=?`,nodeId);
  if(!root)return {connectivity:0,outDegree:0};
  // Component construction compresses every parent before ranking.
  const count=one(db,`SELECT count(*) AS n FROM ${table} WHERE parent=?`,String(root.parent));
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
  for(const edge of rows(db,`SELECT e.from_node,e.to_node FROM edges e JOIN selected_edges s ON s.id=e.id WHERE ${condition}`))
    { if (++work%1000===0) await checkpoint(); union.union(String(edge.from_node),String(edge.to_node)); }
  for(const row of rows(db,`SELECT id FROM rank_${profile}`)) { if (++work%1000===0) await checkpoint(); union.find(String(row.id)); }
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
  db.exec("CREATE TEMP TABLE component_stats(root TEXT PRIMARY KEY,min_id TEXT NOT NULL,length_m REAL NOT NULL DEFAULT 0) STRICT;");
  for(const row of rows(db,"SELECT id FROM portal_components ORDER BY id")) {
    if (++work%1000===0) await checkpoint();
    const id=String(row.id),root=union.find(id);
    run(db,"INSERT INTO component_stats(root,min_id,length_m) VALUES (?,?,0) ON CONFLICT(root) DO UPDATE SET min_id=min(min_id,excluded.min_id)",root,id);
  }
  for(const row of rows(db,"SELECT a,length_m FROM trail_links")) { if (++work%1000===0) await checkpoint(); run(db,"UPDATE component_stats SET length_m=length_m+? WHERE root=?",Number(row.length_m),union.find(String(row.a))); }
  const reuseInclusive=!one(db,`SELECT 1 FROM edges e JOIN selected_edges s ON s.id=e.id WHERE e.access_state NOT IN ('public','unknown') LIMIT 1`);
  await rankComponents(db,"known",checkpoint);
  if(!reuseInclusive)await rankComponents(db,"inclusive",checkpoint);
  db.exec(`DROP TABLE IF EXISTS temp.road_nodes; CREATE TEMP TABLE road_nodes(node_id TEXT PRIMARY KEY,road_class TEXT NOT NULL) STRICT;
    INSERT INTO road_nodes SELECT x.node_id,CASE WHEN max(w.edge_class='street') THEN 'street' ELSE 'service-road' END
    FROM way_nodes x JOIN ways w ON w.id=x.way_id WHERE w.edge_class IN ('street','service-road') AND w.access_state NOT IN (${restricted}) GROUP BY x.node_id;
    DROP TABLE IF EXISTS temp.portal_candidates; CREATE TEMP TABLE portal_candidates(rid INTEGER PRIMARY KEY,node_id TEXT NOT NULL UNIQUE,road_class TEXT NOT NULL,direct INTEGER NOT NULL) STRICT;
    CREATE VIRTUAL TABLE temp.candidate_spatial USING rtree(rid,min_lon,max_lon,min_lat,max_lat);`);
  const addCandidate=(nodeId:string,roadClass:"street"|"service-road",direct:boolean)=>{
    const prior=one(db,"SELECT road_class FROM portal_candidates WHERE node_id=?",nodeId);
    if(prior){if(roadClass==="street"&&prior.road_class!=="street")run(db,"UPDATE portal_candidates SET road_class='street' WHERE node_id=?",nodeId);return;}
    const nodeRow=one(db,"SELECT lon,lat FROM nodes WHERE id=?",nodeId);if(!nodeRow)return;
    const lon=Number(nodeRow.lon),lat=Number(nodeRow.lat);
    if(!coordinateIsInsideArea([lon,lat],coverage))return;
    const result=run(db,"INSERT INTO portal_candidates(node_id,road_class,direct) VALUES (?,?,?)",nodeId,roadClass,Number(direct));
    const rid=Number(result.lastInsertRowid);run(db,"INSERT INTO candidate_spatial VALUES (?,?,?,?,?)",rid,lon,lon,lat,lat);
  };
  for(const row of rows(db,"SELECT r.node_id,r.road_class,n.lon,n.lat FROM road_nodes r JOIN portal_components c ON c.id=r.node_id JOIN nodes n ON n.id=r.node_id ORDER BY r.node_id")) {
    if (++work%1000===0) await checkpoint();
    if(row.road_class==="street"||(await evidenceNear(db,Number(row.lon),Number(row.lat),250,checkpoint)).length) addCandidate(String(row.node_id),String(row.road_class) as "street"|"service-road",true);
  }
  // Require an actual approach along the tagged trail, never a nearby unrelated track.
  // OSM trailheads may be mapped along a highway, not necessarily at its junction:
  // https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrailhead
  for(const row of rows(db,"SELECT e.record FROM evidence e WHERE e.kind='trailhead'")) {
    if (++work%1000===0) await checkpoint();
    const item=JSON.parse(String(row.record)) as NormalizedPortalEvidence;
    if(item.nodeIds.length!==1)continue;
    const nodeId=item.nodeIds[0]!;if(!one(db,"SELECT 1 FROM portal_components WHERE id=?",nodeId))continue;
    const node=one(db,"SELECT record FROM nodes WHERE id=?",nodeId);
    if(!node || !item.externalId.startsWith("node/") || item.accessState==="private" || item.accessState==="closed" || item.accessState==="prohibited" || (JSON.parse(String(node.record)) as NormalizedNode).externalId!==item.externalId)continue;
    if(await hasNearbyTrackApproach(db,nodeId,checkpoint))addCandidate(nodeId,"service-road",false);
  }
  // One parking feature creates at most one snapped candidate, even when its area has many vertices.
  for(const evidenceRow of rows(db,"SELECT id,record FROM evidence WHERE kind='parking'")) {
    if (++work%1000===0) await checkpoint();
    const item=JSON.parse(String(evidenceRow.record)) as NormalizedPortalEvidence;
    if(!allowedAccess(item))continue;
    const coordinates=[...rows(db,"SELECT lon,lat FROM evidence_points WHERE evidence_id=?",String(evidenceRow.id))]
      .map(({lon,lat})=>[Number(lon),Number(lat)] as [number,number]);
    let roadClass:"street"|"service-road"|null=null;
    for(const nodeId of item.nodeIds) {
      if (++work%1000===0) await checkpoint();
      const contact=one(db,"SELECT road_class FROM road_nodes WHERE node_id=?",nodeId);
      if(contact?.road_class==="street"){roadClass="street";break;}
      if(contact?.road_class==="service-road")roadClass="service-road";
    }
    if(!roadClass) for(const [lon,lat] of coordinates) {
      if (++work%1000===0) await checkpoint();
      for(const road of rows(db,`SELECT n.lon,n.lat,r.road_class FROM nodes_spatial s JOIN nodes n ON n.rowid=s.id JOIN road_nodes r ON r.node_id=n.id
        WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?`,...box(lon,lat,25))) {
        if (++work%1000===0) await checkpoint();
        if(distance([lon,lat],[Number(road.lon),Number(road.lat)])<=25){roadClass=road.road_class==="street"?"street":"service-road";if(roadClass==="street")break;}
      }
      if(roadClass==="street")break;
    }
    if(!roadClass) {
      // A mapped parking area can join a track and hiking path at different
      // vertices. Keep the start on that path; never manufacture a parking edge.
      const tracks:Array<{id:string;coordinates:readonly [number,number]}>=[],trails:typeof tracks=[];
      for(const nodeId of [...new Set(item.nodeIds)]) {
        await checkpoint();
        const incident=waysAt(db,nodeId).filter(allowedAccess);
        const node=one(db,"SELECT lon,lat FROM nodes WHERE id=?",nodeId);
        if(!node)continue;
        const contact={id:nodeId,coordinates:[Number(node.lon),Number(node.lat)] as const};
        if(incident.some(trackWay))tracks.push(contact);
        if(incident.some(way=>hikingWay(way)&&selectedWayAt(db,way,nodeId)))trails.push(contact);
      }
      const contacts=trails.map(trail=>({...trail,distance:Math.min(...tracks.map(track=>distance(track.coordinates,trail.coordinates)))}))
        .filter(contact=>contact.distance<=250).sort((a,b)=>a.distance-b.distance||a.id.localeCompare(b.id));
      if(contacts[0])addCandidate(contacts[0].id,"service-road",false);
      continue;
    }
    let nearest:{id:string;distance:number}|null=null;
    for(const [lon,lat] of coordinates) {
      if (++work%1000===0) await checkpoint();
      for(const trail of rows(db,`SELECT n.id,n.lon,n.lat FROM nodes_spatial s JOIN nodes n ON n.rowid=s.id JOIN portal_components c ON c.id=n.id
        WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?`,...box(lon,lat,250))) {
        if (++work%1000===0) await checkpoint();
        const measured=distance([lon,lat],[Number(trail.lon),Number(trail.lat)]);
        if(measured<=250&&(!nearest||measured<nearest.distance||(measured===nearest.distance&&String(trail.id)<nearest.id)))nearest={id:String(trail.id),distance:measured};
      }
    }
    if(nearest)addCandidate(nearest.id,roadClass,false);
  }
  if(!one(db,"SELECT 1 FROM portal_candidates LIMIT 1")) {
    run(db,"DELETE FROM derived_portals WHERE coverage_hash=?",coverageHash);
    return 0;
  }
  run(db,"DELETE FROM derived_portals WHERE coverage_hash=?",coverageHash);
  let count=0;
  for(const row of rows(db,"SELECT c.node_id,c.road_class,c.direct,n.record FROM portal_candidates c JOIN nodes n ON n.id=c.node_id ORDER BY c.node_id")) {
    if (++work%1000===0) await checkpoint();
    const node=JSON.parse(String(row.record)) as NormalizedNode,nodeId=node.id,incident=waysAt(db,nodeId),evidence=await evidenceNear(db,node.lon,node.lat,250,checkpoint);
    const component=one(db,"SELECT min_id,length_m FROM component_stats WHERE root=?",union.find(nodeId))!;
    const named=evidence.find(({item})=>item.kind==="trailhead"&&item.name?.trim())??evidence.find(({item})=>item.kind==="information"&&item.name?.trim())??evidence.find(({item})=>item.kind==="gate"&&item.name?.trim());
    const trailName=incident.map(({name})=>name?.trim()).filter((name):name is string=>!!name).sort()[0];
    const parking=evidence.filter(({item})=>item.kind==="parking").sort((a,b)=>a.distanceM-b.distanceM||a.item.id.localeCompare(b.item.id))[0];
    const states=new Set(incident.map(({accessState})=>accessState));
    const accessState=( ["closed","prohibited","private","unknown","public"] as const).find((state)=>states.has(state))??"unknown";
    const known=ranking(db,nodeId,"known",reuseInclusive),inclusive=ranking(db,nodeId,"inclusive",reuseInclusive);
    const point:NormalizedAccessPoint={id:`portal:${nodeId}`,externalId:node.externalId,nodeId,name:named?.item.name??(trailName?`${trailName} trailhead`:"Trailhead"),kind:"trailhead",accessState,
      confidence:evidence.some(({item})=>item.kind==="trailhead")?"high":evidence.length?"medium":"low",parkingEvidence:parking?`portal-evidence:${parking.item.externalId}`:null,
      sourceRefs:[...new Set([...node.sourceRefs,...incident.flatMap(({sourceRefs})=>sourceRefs),...evidence.flatMap(({item})=>item.sourceRefs)])].sort(),
      knownConnectivity:known.connectivity,inclusiveConnectivity:inclusive.connectivity,knownOutDegree:known.outDegree,inclusiveOutDegree:inclusive.outDegree,
      reachableTrailKm:Number(component.length_m)/1000,trailComponentId:`trail-component:${component.min_id}`,portalRoadClass:String(row.road_class) as "street"|"service-road",parkingDistanceM:parking?.distanceM??null,nearbyBuildingCount:await nearbyBuildings(db,node.lon,node.lat,checkpoint)};
    run(db,"INSERT INTO derived_portals VALUES (?,?,?,?)",coverageHash,point.id,nodeId,JSON.stringify(point));count++;
  }
  await checkpoint();
  return count;
  } finally {
    statementCaches.delete(db);
    for (const table of ["representatives","clusters","candidate_spatial","portal_candidates","road_nodes","rank_known","rank_inclusive","component_stats","trail_links","portal_components"]) db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}
