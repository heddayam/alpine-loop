import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AreaGeometry } from "../area-geometry";
import { compiledEdgesForSegment } from "../compiled-edges";
import { normalizeOsmOpl } from "../osm/opl";
import type { NormalizedNode, NormalizedWay } from "../types";
import { ConnectedEntryProof, type PreparedEntry } from "./entry-proof";
import { prepareSparsePortalCandidates } from "./portals";
import { openProgressiveGraphStore, type ProgressiveGraphStore } from "./store";

const coverage:AreaGeometry={type:"Polygon",coordinates:[[[-123,47],[-120,47],[-120,49],[-123,49],[-123,47]]]};
const simple=`n1 x-122.001 y48
n2 x-122 y48
n3 x-121.999 y48
w10 Thighway=residential Nn1,n2
w20 Thighway=path,foot=yes,name=Public%20%trail Nn2,n3`;

async function staged(opl:string,stagingPath=":memory:") {
  const topology=normalizeOsmOpl(opl,"fixture");
  const store=openProgressiveGraphStore({stagingPath,buildIdentity:"frozen-refresh"}),db=store.database;
  db.exec("CREATE TEMP TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT NOT NULL,to_node TEXT NOT NULL,length_m REAL NOT NULL) STRICT;");
  const add=db.prepare("INSERT INTO eligible_segments VALUES (?,?,?,1)");
  store.transaction(()=>{
    topology.nodes.forEach(node=>store.putNode(node));
    topology.portalEvidence?.forEach(item=>store.putPortalEvidence(item));
    for(const way of topology.ways) {
      store.putWay(way);
      if(way.edgeClass!=="trail"||!["public","unknown"].includes(way.accessState))continue;
      for(let index=0;index<way.nodeIds.length-1;index++)add.run(`${way.id}:${index}`,way.nodeIds[index]!,way.nodeIds[index+1]!);
    }
  });
  await prepareSparsePortalCandidates(store,coverage);
  db.exec("CREATE TEMP TABLE selected_edges(id TEXT PRIMARY KEY) STRICT;");
  const select=db.prepare("INSERT INTO selected_edges VALUES (?)");
  store.transaction(()=>{
    for(const way of topology.ways) {
      if(way.edgeClass!=="trail")continue;
      for(let index=0;index<way.nodeIds.length-1;index++) {
        const geometry=way.coordinates.slice(index,index+2);
        const nodeFlags=[way.nodeIds[index]!,way.nodeIds[index+1]!].map(id=>topology.nodes.find(node=>node.id===id)!.flags);
        for(const edge of compiledEdgesForSegment(way,index,geometry,{lengthM:1,gainM:0,lossM:0,maxElevationM:0,maxSustainedGradePct:0,elevationProfile:null},{nodeFlags})) {
          store.putEdge(edge);select.run(edge.id);
        }
      }
    }
  });
  return {store,topology};
}
function frozen(store:ProgressiveGraphStore) {
  return store.database.prepare("SELECT node_id,witness FROM sparse_portal_candidates ORDER BY node_id").all()
    .map(row=>({node:String(row.node_id),witness:JSON.parse(String(row.witness)) as PreparedEntry}));
}
async function refreshed(store:ProgressiveGraphStore,full=false) {
  const values=frozen(store),db=store.database,proof=new ConnectedEntryProof(db,async()=>{});
  // The legacy no-freeze call exercises the unchanged source-wide preparation.
  if(full)db.exec("ALTER TABLE sparse_portal_candidates RENAME TO saved_candidates");
  try {
    await proof.prepare("measured",false);
    const result=values.map(({node,witness})=>({node,witness:proof.refresh(node,witness)}));
    const scratch=Object.fromEntries(["entry_nodes","entry_contacts","entry_roots","entry_links"].map(table=>[table,Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]));
    return {result,scratch};
  } finally {
    proof.clear();
    if(full)db.exec("ALTER TABLE saved_candidates RENAME TO sparse_portal_candidates");
  }
}
function updateWay(store:ProgressiveGraphStore,way:NormalizedWay) {
  store.database.prepare("UPDATE ways SET record=?,edge_class=?,access_state=? WHERE id=?").run(JSON.stringify(way),way.edgeClass??"trail",way.accessState,way.id);
}
function addIrrelevant(store:ProgressiveGraphStore,count:number) {
  const select=store.database.prepare("INSERT INTO selected_edges VALUES (?)");
  store.transaction(()=>{
    for(let i=0;i<count;i++) {
      const first=`unused-${i}-a`,second=`unused-${i}-b`,way=`unused-${i}`;
      const a:[number,number]=[-121,48],b:[number,number]=[-120.999,48];
      for(const [id,point] of [[first,a],[second,b]] as const)store.putNode({id,externalId:`node/${id}`,lon:point[0],lat:point[1],elevationM:null,flags:[],sourceRefs:["irrelevant"]});
      store.putWay({id:way,externalId:`way/${way}`,nodeIds:[first,second],coordinates:[a,b],name:"Unrelated road",accessState:"public",bidirectional:true,edgeClass:"street",flags:["osm-highway:residential"],sourceRefs:["irrelevant"]});
      for(const reverse of [false,true]) {
        const id=`${way}:${reverse?"reverse":"forward"}`;
        store.putEdge({id,stablePhysicalId:way,fromNode:reverse?second:first,toNode:reverse?first:second,geometry:reverse?[b,a]:[a,b],lengthM:1,gainM:0,lossM:0,maxElevationM:0,maxSustainedGradePct:0,accessState:"public",edgeClass:"trail",flags:["osm-highway:path"],sourceRefs:["irrelevant"]});
        select.run(id);
      }
    }
  });
}

describe("frozen measured entry preparation",()=>{
  it("matches full preparation for source places, walking approaches and directional passages",async()=>{
    const opl=`${simple}
n4 Thighway=trailhead,name=Actual%20%start x-121.998 y48
n5 x-121.997 y48
n6 x-121.996 y48
n7 x-121.995 y48
n8 x-121.994 y48
n9 x-121.993 y48
n10 Thighway=turning_circle x-121.992 y48
n11 Thighway=trailhead,name=Turnaround%20%start x-121.991 y48
n12 x-121.990 y48
n13 Tbarrier=gate,foot=no x-121.989 y48
n14 x-121.988 y48
w21 Thighway=path,foot=yes,foot:forward=private,foot:backward=yes Nn4,n3
w22 Thighway=path Nn4,n5
w30 Thighway=service,foot=yes,motor_vehicle=no Nn2,n6
w31 Thighway=path,foot=yes Nn6,n7
w40 Thighway=track Nn9,n10
w41 Thighway=path,foot=yes Nn10,n11,n12
w42 Thighway=path,foot=yes Nn2,n13,n14
w50 Thighway=track,foot=no,motor_vehicle=yes Nn8,n7
w60 Tamenity=parking,foot:conditional=yes%20%@%20%(daylight) Nn8,n7,n6,n8`;
    const {store}=await staged(opl);
    try {
      expect(frozen(store).some(value=>value.witness.kind==="parking"&&!value.witness.approachKnown)).toBe(true);
      expect(frozen(store).some(value=>value.witness.kind==="trailhead")).toBe(true);
      const baseline=await refreshed(store,true),targeted=await refreshed(store);
      expect(JSON.stringify(targeted.result)).toBe(JSON.stringify(baseline.result));
      expect(targeted.result.every(value=>value.witness)).toBe(true);
    } finally {store.close();}
  });

  it.each(["restricted","deleted","detached","role-changed"])("does not replace a %s original road assertion with a new arrival",async reason=>{
    const {store,topology}=await staged(simple);
    try {
      const original=topology.ways.find(way=>way.flags.includes("osm-highway:residential"))!;
      store.putWay({...original,id:"new-road",externalId:"way/new-road"});
      if(reason==="deleted")store.database.prepare("DELETE FROM ways WHERE id=?").run(original.id);
      else updateWay(store,{...original,...(reason==="restricted"?{accessState:"private",flags:["osm-highway:residential","motor-access:private"]}:reason==="role-changed"?{flags:["osm-highway:trunk"]}:{nodeIds:[original.nodeIds[0]!],coordinates:[original.coordinates[0]!]})});
      const baseline=await refreshed(store,true),targeted=await refreshed(store);
      expect(targeted.result).toEqual(baseline.result);
      expect(targeted.result).toEqual([{node:"osm-node-2",witness:undefined}]);
      expect(frozen(store)).toHaveLength(1);
    } finally {store.close();}
  });

  it("cannot substitute another typed place sharing the original arrival contact",async()=>{
    const {store,topology}=await staged(`${simple}
n4 x-121.998 y48
n5 x-121.997 y48
n6 x-121.996 y48
w30 Thighway=track Nn4,n5
w31 Thighway=path,foot=yes Nn5,n6
w40 Tamenity=parking Nn4,n5
w41 Tamenity=parking Nn4,n5`);
    try {
      const first=topology.portalEvidence!.filter(item=>item.kind==="parking").sort((a,b)=>a.id.localeCompare(b.id))[0]!;
      const prior=frozen(store).find(value=>value.witness.rootAssertion===first.id)!;
      expect(prior).toBeDefined();
      store.database.prepare("DELETE FROM evidence WHERE id=?").run(first.id);
      const baseline=await refreshed(store,true),targeted=await refreshed(store);
      expect(targeted.result).toEqual(baseline.result);
      expect(targeted.result.find(value=>value.node===prior.node)!.witness).toBeUndefined();
    } finally {store.close();}
  });

  it("matches unknown node passage with unmeasured walking context, and drops a removed departure",async()=>{
    const {store}=await staged(`${simple.replace("n2 x","n2 Tbarrier=gate,foot:conditional=yes%20%@%20%(daylight) x")}
n4 x-121.998 y48
n5 Tbarrier=gate,foot=no x-121.997 y48
w30 Thighway=footway,footway=sidewalk,foot=yes Nn2,n4
w31 Thighway=footway,footway=sidewalk,foot=yes Nn2,n5`);
    try {
      const before=frozen(store);
      expect(before[0]!.witness).toMatchObject({known:false,approachKnown:true});
      const baseline=await refreshed(store,true),targeted=await refreshed(store);
      expect(targeted.result).toEqual(baseline.result);
      expect(targeted.result[0]!.witness).toMatchObject({known:false,approachKnown:true});
      expect(baseline.scratch.entry_links).toBeGreaterThan(targeted.scratch.entry_links);
      store.database.prepare("DELETE FROM selected_edges WHERE id IN (SELECT id FROM edges WHERE from_node=?)").run(before[0]!.node);
      expect((await refreshed(store)).result).toEqual((await refreshed(store,true)).result);
      expect((await refreshed(store)).result[0]!.witness).toBeUndefined();
    } finally {store.close();}
  });

  it("keeps place assertion identity, restrictions and the frozen unknown foot profile",async()=>{
    const {store,topology}=await staged(`${simple}
n4 x-121.998 y48
n5 x-121.997 y48
w30 Thighway=track,foot=no,motor_vehicle=yes Nn4,n5
w31 Thighway=path,foot=yes Nn5,n3
w40 Tamenity=parking,foot:conditional=yes%20%@%20%(daylight) Nn4,n5,n3,n4`);
    try {
      const item=topology.portalEvidence!.find(item=>item.kind==="parking")!;
      const values=frozen(store).filter(value=>value.witness.rootAssertion===item.id);
      expect(values).toHaveLength(2);
      expect(values.every(value=>!value.witness.approachKnown&&!value.witness.known)).toBe(true);
      store.database.prepare("UPDATE evidence SET record=? WHERE id=?").run(JSON.stringify({...item,accessState:"public",flags:["foot-access:public"]}),item.id);
      const upgraded=await refreshed(store);
      expect(upgraded.result.filter(value=>values.some(prior=>prior.node===value.node)).every(value=>value.witness&&!value.witness.known&&!value.witness.approachKnown)).toBe(true);
      const contact=topology.ways.find(way=>way.flags.includes("osm-highway:track"))!;
      store.putWay({...contact,id:"new-road",externalId:"way/new-road",accessState:"public",edgeClass:"street",flags:["osm-highway:residential"]});
      store.database.prepare("UPDATE evidence SET record=? WHERE id=?").run(JSON.stringify({...item,flags:["foot-access:private"]}),item.id);
      const baseline=await refreshed(store,true),targeted=await refreshed(store);
      expect(targeted.result).toEqual(baseline.result);
      expect(targeted.result.filter(value=>values.some(prior=>prior.node===value.node)).every(value=>!value.witness)).toBe(true);
    } finally {store.close();}
  });

  it("does not replace a removed turning-circle assertion or walk a forbidden node",async()=>{
    const {store,topology}=await staged(`n1 x-122.001 y48
n2 Thighway=turning_circle x-122 y48
n3 x-121.999 y48
w10 Thighway=track Nn1,n2
w20 Thighway=path,foot=yes Nn2,n3`);
    try {
      expect(frozen(store)).toHaveLength(1);
      const place=topology.nodes.find(node=>node.flags.includes("arrival-place:turning-circle"))!;
      const write=(node:NormalizedNode)=>store.database.prepare("UPDATE nodes SET record=? WHERE id=?").run(JSON.stringify(node),node.id);
      write({...place,flags:[...place.flags,"foot-access:private"]});
      expect((await refreshed(store)).result.every(value=>!value.witness)).toBe(true);
      write({...place,flags:[]});
      const approach=topology.ways[0]!;
      store.putWay({...approach,id:"new-road",externalId:"way/new-road",edgeClass:"street",flags:["osm-highway:residential"]});
      expect((await refreshed(store)).result).toEqual((await refreshed(store,true)).result);
      expect((await refreshed(store)).result.every(value=>!value.witness)).toBe(true);
    } finally {store.close();}
  });

  it("keeps a bounded working set when unrelated source and selected graph grow",async()=>{
    const scratch=mkdtempSync(path.join(tmpdir(),"entry-refresh-working-set-"));
    const {store}=await staged(`${simple}
n4 x-121.998 y48
n5 x-121.997 y48
n6 x-121.996 y48
w30 Thighway=track Nn4,n5
w31 Thighway=path,foot=yes Nn5,n6
w40 Tamenity=parking Nn4,n5`,path.join(scratch,"source.sqlite"));
    try {
      const before=await refreshed(store);
      addIrrelevant(store,5000);
      const after=await refreshed(store),baseline=await refreshed(store,true);
      expect(JSON.stringify(after.result)).toBe(JSON.stringify(before.result));
      expect(JSON.stringify(after.result)).toBe(JSON.stringify(baseline.result));
      expect(after.scratch).toEqual(before.scratch);
      expect(after.scratch).toEqual({entry_nodes:5,entry_contacts:2,entry_roots:2,entry_links:3});
      expect(baseline.scratch.entry_nodes).toBe(10006);
      expect(baseline.scratch.entry_links).toBe(10006);
      const plans=store.database.prepare("EXPLAIN QUERY PLAN SELECT e.record FROM edges e WHERE e.from_node=? AND EXISTS (SELECT 1 FROM selected_edges s WHERE s.id=e.id) ORDER BY e.id").all("osm-node-2");
      expect(plans.some(row=>String(row.detail).includes("SEARCH e USING INDEX edges_from"))).toBe(true);
      const contacts=store.database.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT w.id,w.record FROM way_nodes n JOIN ways w ON w.id=n.way_id WHERE n.node_id=? ORDER BY w.id").all("osm-node-4");
      expect(contacts.some(row=>String(row.detail).includes("SEARCH n USING COVERING INDEX way_nodes_node"))).toBe(true);
    } finally {store.close();rmSync(scratch,{recursive:true,force:true});}
  });

  it("reads a shared assertion once, clears an interrupted cursor, and retries frozen candidates",async()=>{
    const count=500,lines=["n9999 x-121.99 y48"];
    for(let i=1;i<=count;i++)lines.push(`n${i} x${-122+i*.000001} y48`,`w${i} Thighway=path,foot=yes Nn${i},n9999`);
    lines.push(`w9999 Thighway=residential N${Array.from({length:count},(_,i)=>`n${i+1}`).join(",")}`);
    const {store}=await staged(lines.join("\n"));
    let checks=0,interrupted=true;
    const proof=new ConnectedEntryProof(store.database,async()=>{if(++checks===2&&interrupted)throw new Error("cancel refresh");});
    try {
      const before=frozen(store);
      await expect(proof.prepare("measured",false)).rejects.toThrow("cancel refresh");
      expect(store.database.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'entry_%' OR name IN ('portal_candidates','portal_evidence')").all()).toEqual([]);
      expect(frozen(store)).toEqual(before);
      interrupted=false;
      let sourceReads=0;
      const original=store.database.prepare;
      store.database.prepare=function(sql:string) {
        const statement=original.call(this,sql);
        if(sql!=="SELECT record FROM ways WHERE id=?")return statement;
        return new Proxy(statement,{get(target,key){
          if(key==="get")return (...args:Parameters<typeof target.get>)=>{sourceReads++;return target.get(...args);};
          const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
        }});
      };
      await proof.prepare("measured",false);
      store.database.prepare=original;
      expect(sourceReads).toBe(1);
      expect(proof.refresh(before[0]!.node,before[0]!.witness)).toBeDefined();
      expect(frozen(store)).toEqual(before);
    } finally {proof.clear();store.close();}
  });
});
