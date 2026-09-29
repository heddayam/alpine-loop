import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { compactPreparedGraph } from "./compact-prepared-graph";
import { createPreparedSchema } from "./sqlite-writer";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { writeProgressiveTopology } from "./progressive/topology";
import { rebuildPreparedSpatialIndexes } from "./prepared-spatial-index";

const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture({spatialIndexes=true}:{spatialIndexes?:boolean}={}) {
  const db=new DatabaseSync(":memory:");databases.push(db);createPreparedSchema(db);db.exec("PRAGMA foreign_keys=ON");
  let nodeKey=0,physicalKey=0,edgeKey=0;
  const positions=new Map<string,[number,number,number]>();
  const node=(id:string,elevation=0,flags:string[]=[])=>{
    const key=++nodeKey,lon=key/1000,lat=0;
    positions.set(id,[lon,lat,elevation]);
    db.prepare("INSERT INTO nodes VALUES(?,?,?,?,?,?)").run(id,key,lon,lat,elevation,JSON.stringify(flags));
    if (spatialIndexes) db.prepare("INSERT INTO node_spatial VALUES(?,?,?,?,?)").run(key,lon,lon,lat,lat);
  };
  const access=(id:string)=>db.prepare(`INSERT INTO access_points VALUES(?,?,?,'trailhead','public','high',NULL,'[]',0,0,0,0,0,0,'component','street',NULL,NULL,NULL)`).run(`access-${id}`,id,id);
  const add=(a:string,b:string,options:{oneway?:boolean;flags?:string[];access?:string;length?:number;profile?:Array<[number,number]>;gain?:number;loss?:number}={})=>{
    const pa=positions.get(a)!,pb=positions.get(b)!,key=++physicalKey,length=options.length??60;
    const geometry=[[pa[0],pa[1]],[pb[0],pb[1]]];
    const forward=canonicalTopologyJson(geometry),reverse=canonicalTopologyJson([...geometry].reverse());
    const nodeA=Number(db.prepare("SELECT node_key FROM nodes WHERE id=?").get(a)!.node_key),nodeB=Number(db.prepare("SELECT node_key FROM nodes WHERE id=?").get(b)!.node_key);
    db.prepare("INSERT INTO physical_edges VALUES(?,?,?,?,?)").run(key,`physical-${key}`,Math.min(nodeA,nodeB),Math.max(nodeA,nodeB),topologySha256(forward<reverse?forward:reverse));
    const profile=options.profile??[[0,pa[2]],[length,pb[2]]];
    const gain=options.gain??Math.max(0,pb[2]-pa[2]),loss=options.loss??Math.max(0,pa[2]-pb[2]);
    for(const backwards of options.oneway?[false]:[false,true]) {
      const ek=++edgeKey;
      db.prepare("INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`edge-${ek}`,ek,key,backwards?b:a,backwards?a:b,
        JSON.stringify(backwards?[...geometry].reverse():geometry),length,backwards?loss:gain,backwards?gain:loss,Math.max(...profile.map(p=>p[1])),null,
        JSON.stringify(backwards?[...profile].reverse().map(([d,e])=>[length-d,e]):profile),options.access??"public","trail",'["fixture"]',JSON.stringify(options.flags??["osm-feature:way/1"]));
      if (spatialIndexes) db.prepare("INSERT INTO edge_spatial VALUES(?,?,?,?,?)").run(ek,Math.min(pa[0],pb[0]),Math.max(pa[0],pb[0]),0,0);
    }
  };
  return {db,node,access,add};
}
/** Enumerate small fixture loops/lollipops and compare expanded shape and additive metrics. */
function routes(db:DatabaseSync,start:string):string[] {
  type Edge={physical_edge_key:number;from_node:string;to_node:string;geometry:string;length_m:number;gain_m:number;loss_m:number};
  const edges=db.prepare("SELECT * FROM edges ORDER BY edge_key").all() as Edge[],result=new Set<string>();
  const walk=(node:string,nodes:string[],path:Edge[])=>{
    for(const edge of edges.filter(item=>item.from_node===node)) {
      if(path.some(item=>item.physical_edge_key===edge.physical_edge_key))continue;
      const closes=nodes.indexOf(edge.to_node),next=[...path,edge];
      if(closes>=0) {
        const stem=path.slice(0,closes).reverse().map(out=>edges.find(back=>back.physical_edge_key===out.physical_edge_key&&back.from_node===out.to_node));
        if(stem.some(item=>!item))continue;
        const route=[...next,...stem as Edge[]],geometry=route.flatMap((item,index)=>(JSON.parse(item.geometry) as number[][]).slice(index?1:0));
        result.add(JSON.stringify({geometry,length:route.reduce((sum,item)=>sum+item.length_m,0),gain:route.reduce((sum,item)=>sum+item.gain_m,0),loss:route.reduce((sum,item)=>sum+item.loss_m,0)}));
      } else walk(edge.to_node,[...nodes,edge.to_node],next);
    }
  };
  walk(start,[start],[]);return [...result].sort();
}
function integrity(db:DatabaseSync) {
  expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("SELECT count(*) AS n FROM node_spatial").get()!.n).toBe(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n);
  expect(db.prepare("SELECT count(*) AS n FROM edge_spatial").get()!.n).toBe(db.prepare("SELECT count(*) AS n FROM edges").get()!.n);
}

describe("persistent junction graph",()=>{
  it("uses indexed foreign-key checks when removing corridor edges and shape nodes",()=>{
    const {db}=fixture();
    for(const sql of ["DELETE FROM physical_edges WHERE physical_edge_key=?", "DELETE FROM nodes WHERE id=?"]) {
      const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1).map(row=>String(row.detail));
      expect(plan.filter(detail=>/^SCAN\b/.test(detail))).toEqual([]);
    }
  });
  it("preserves lollipop routes, all access nodes, geometry, metrics, and topology hints",async()=>{
    const {db,node,access,add}=fixture();
    for(const id of ["s","stem","j","a","b","c"])node(id);
    access("s");access("a");add("s","stem");add("stem","j");add("j","a");add("a","b");add("b","c");add("c","j");
    const before=[routes(db,"s"),routes(db,"a")];
    const count=await compactPreparedGraph(db,async()=>{});
    expect(count).toEqual({beforeNodes:6,beforePhysicalEdges:6,nodes:3,physicalEdges:3});
    expect([routes(db,"s"),routes(db,"a")]).toEqual(before);
    await writeProgressiveTopology(db);
    expect(db.prepare("SELECT inclusive_minimum_stem_m FROM access_points WHERE node_id='s'").get()!.inclusive_minimum_stem_m).toBe(120);
    expect(db.prepare("SELECT inclusive_minimum_stem_m FROM access_points WHERE node_id='a'").get()!.inclusive_minimum_stem_m).toBe(0);
    integrity(db);
  });
  it.each([true,false])("retains unanchored rings, parallel paths and directed cycle legality with spatial indexes %s",async(spatialIndexes)=>{
    const {db,node,access,add}=fixture({spatialIndexes});
    for(const id of ["a","b","c","d","x","y","z"])node(id);
    access("a");add("a","b",{oneway:true});add("b","c",{oneway:true});add("c","d",{oneway:true});add("d","a",{oneway:true});
    add("x","y");add("y","z");add("z","x");
    const before=routes(db,"a");
    expect(await compactPreparedGraph(db,async()=>{},{spatialIndexes})).toEqual({beforeNodes:7,beforePhysicalEdges:7,nodes:4,physicalEdges:4});
    if (!spatialIndexes) await rebuildPreparedSpatialIndexes(db,async()=>{});
    expect(routes(db,"a")).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM physical_edges WHERE from_node_key=to_node_key").get()!.n).toBe(0);
    integrity(db);
  });
  it("keeps semantic and one-way transitions plus flagged nodes as endpoints",async()=>{
    const {db,node,access,add}=fixture();
    for(const id of ["a","b","c","d","e","f","g"])node(id,0,id==="f"?["gate"]:[]);
    access("a");add("a","b");add("b","c",{flags:["osm-feature:way/2"]});add("c","d",{flags:["osm-feature:way/2"],access:"unknown"});
    add("d","e",{oneway:true,access:"unknown"});add("e","f",{oneway:true,access:"unknown"});add("f","g",{oneway:true,access:"unknown"});
    await compactPreparedGraph(db,async()=>{});
    expect(db.prepare("SELECT id FROM nodes ORDER BY id").all().map(row=>row.id)).toEqual(["a","b","c","d","f","g"]);
    expect(db.prepare("SELECT count(*) AS n FROM edges WHERE from_node='f' AND to_node='d'").get()!.n).toBe(0);
    integrity(db);
  });
  it("recomputes grade across seams without smoothing or recomputing gain/loss",async()=>{
    const {db,node,add}=fixture();node("a",0);node("b",6);node("c",12);
    add("a","b",{profile:[[0,0],[20,2],[40,4],[60,6]],gain:5.4});
    add("b","c",{profile:[[0,6],[20,8],[40,10],[60,12]],gain:5.5});
    await compactPreparedGraph(db,async()=>{});
    const forward=db.prepare("SELECT * FROM edges WHERE from_node='a'").get()!;
    expect(forward.length_m).toBe(120);expect(forward.gain_m).toBe(10.9);expect(forward.max_sustained_grade_pct).toBe(10);
    expect(JSON.parse(String(forward.elevation_profile))).toEqual([[0,0],[20,2],[40,4],[60,6],[80,8],[100,10],[120,12]]);
    const reverse=db.prepare("SELECT * FROM edges WHERE from_node='c'").get()!;
    expect(reverse.loss_m).toBe(10.9);expect(reverse.max_sustained_grade_pct).toBe(10);
    integrity(db);
  });
  it("splits at the serialized byte limit while preserving both corridor directions",async()=>{
    const {db,node,add}=fixture();
    for(const id of ["a","b","c","d","e"])node(id);
    add("a","b");add("b","c");add("c","d");add("d","e");
    // Valid JSON whitespace exercises stored-byte accounting without allocating
    // hundreds of thousands of geometry/profile samples in this fixture.
    db.prepare("UPDATE edges SET geometry=geometry||?").run(" ".repeat(1_400_000));
    const sizes=db.prepare(`SELECT sum(length(geometry)+length(elevation_profile)) AS bytes
      FROM edges GROUP BY physical_edge_key`).all().map(row=>Number(row.bytes));
    expect(Math.max(...sizes)*2).toBeLessThan(8*1024*1024);
    expect(Math.min(...sizes)*3).toBeGreaterThan(8*1024*1024);
    expect(await compactPreparedGraph(db,async()=>{})).toEqual({beforeNodes:5,beforePhysicalEdges:4,nodes:3,physicalEdges:2});
    expect(db.prepare("SELECT id FROM nodes ORDER BY id").all().map(row=>row.id)).toEqual(["a","c","e"]);
    const edges=db.prepare("SELECT from_node,to_node,geometry,elevation_profile,length_m FROM edges ORDER BY from_node,to_node").all();
    expect(edges.map(row=>[row.from_node,row.to_node,row.length_m])).toEqual([
      ["a","c",120],["c","a",120],["c","e",120],["e","c",120],
    ]);
    expect(edges.map(row=>JSON.parse(String(row.geometry)))).toEqual([
      [[0.001,0],[0.002,0],[0.003,0]],[[0.003,0],[0.002,0],[0.001,0]],
      [[0.003,0],[0.004,0],[0.005,0]],[[0.005,0],[0.004,0],[0.003,0]],
    ]);
    for(const row of edges)expect(JSON.parse(String(row.elevation_profile))).toEqual([[0,0],[60,0],[120,0]]);
    integrity(db);
  });
  it.each([true,false])("bounds long corridors and rolls back cancellation without losing source rows with spatial indexes %s",async(spatialIndexes)=>{
    const {db,node,add}=fixture({spatialIndexes});for(let index=0;index<=2050;index++)node(`n${String(index).padStart(4,"0")}`);
    for(let index=0;index<2050;index++)add(`n${String(index).padStart(4,"0")}`,`n${String(index+1).padStart(4,"0")}`);
    let checks=0;
    await expect(compactPreparedGraph(db,async()=>{if(++checks===4)throw new Error("cancelled");},{spatialIndexes})).rejects.toThrow("cancelled");
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n).toBe(2051);
    const counts=await compactPreparedGraph(db,async()=>{},{spatialIndexes});
    if (!spatialIndexes) await rebuildPreparedSpatialIndexes(db,async()=>{});
    expect(counts.nodes).toBe(3);expect(counts.physicalEdges).toBe(2);
    expect(db.prepare("SELECT max(json_array_length(elevation_profile)) AS n FROM edges").get()!.n).toBe(2049);
    integrity(db);
  });
  it("rejects deferred compaction on populated indexes and preserves caller transactions",async()=>{
    const {db,node,add}=fixture();node("a");node("b");add("a","b");
    await expect(compactPreparedGraph(db,async()=>{},{spatialIndexes:false})).rejects.toThrow("requires empty spatial indexes");
    integrity(db);
    db.exec("BEGIN");
    await expect(rebuildPreparedSpatialIndexes(db,async()=>{})).rejects.toThrow("no active transaction");
    expect(db.isTransaction).toBe(true);db.exec("ROLLBACK");
  });
  it("rolls back a cancelled index rebuild before atomically replacing stale rows",async()=>{
    const {db,node,add}=fixture();node("a");node("b");node("c");add("a","b");add("b","c");
    await compactPreparedGraph(db,async()=>{});
    db.exec("DELETE FROM node_spatial; DELETE FROM edge_spatial; INSERT INTO node_spatial VALUES(999,1,1,2,2); INSERT INTO edge_spatial VALUES(999,3,3,4,4)");
    const beforeNodes=db.prepare("SELECT * FROM node_spatial").all(),beforeEdges=db.prepare("SELECT * FROM edge_spatial").all();
    let checks=0;
    await expect(rebuildPreparedSpatialIndexes(db,async()=>{if (++checks===2) throw new Error("cancelled index rebuild");})).rejects.toThrow("cancelled index rebuild");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT * FROM node_spatial").all()).toEqual(beforeNodes);
    expect(db.prepare("SELECT * FROM edge_spatial").all()).toEqual(beforeEdges);
    await rebuildPreparedSpatialIndexes(db,async()=>{});
    expect(db.prepare("SELECT * FROM node_spatial WHERE row_id=999").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM edge_spatial WHERE row_id=999").get()).toBeUndefined();
    integrity(db);
  });
  it("bounds index rebuild work and rolls back an interrupted partial batch",async()=>{
    const {db,node}=fixture({spatialIndexes:false});
    for (let index=0;index<1001;index++) node(`n${String(index).padStart(4,"0")}`);
    let checks=0;
    await expect(rebuildPreparedSpatialIndexes(db,async()=>{
      if (++checks===2) {
        expect(db.prepare("SELECT count(*) AS n FROM node_spatial").get()!.n).toBe(999);
        throw new Error("cancelled partial indexes");
      }
    })).rejects.toThrow("cancelled partial indexes");
    expect(db.prepare("SELECT count(*) AS n FROM node_spatial").get()!.n).toBe(0);
    expect(db.isTransaction).toBe(false);
    await rebuildPreparedSpatialIndexes(db,async()=>{});
    integrity(db);
  });
});
