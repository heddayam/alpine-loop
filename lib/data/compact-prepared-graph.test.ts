import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { compactPreparedGraph } from "./compact-prepared-graph";
import { createPreparedSchema } from "./sqlite-writer";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { writeProgressiveTopology } from "./progressive/topology";

const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture() {
  const db=new DatabaseSync(":memory:");databases.push(db);createPreparedSchema(db);db.exec("PRAGMA foreign_keys=ON");
  let nodeKey=0,physicalKey=0,edgeKey=0;
  const positions=new Map<string,[number,number,number]>();
  const node=(id:string,elevation=0,flags:string[]=[])=>{
    const key=++nodeKey,lon=key/1000,lat=0;
    positions.set(id,[lon,lat,elevation]);
    db.prepare("INSERT INTO nodes VALUES(?,?,?,?,?,?)").run(id,key,lon,lat,elevation,JSON.stringify(flags));
    db.prepare("INSERT INTO node_spatial VALUES(?,?,?,?,?)").run(key,lon,lon,lat,lat);
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
      db.prepare("INSERT INTO edge_spatial VALUES(?,?,?,?,?)").run(ek,Math.min(pa[0],pb[0]),Math.max(pa[0],pb[0]),0,0);
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
  it("retains unanchored rings, parallel paths and directed cycle legality",async()=>{
    const {db,node,access,add}=fixture();
    for(const id of ["a","b","c","d","x","y","z"])node(id);
    access("a");add("a","b",{oneway:true});add("b","c",{oneway:true});add("c","d",{oneway:true});add("d","a",{oneway:true});
    add("x","y");add("y","z");add("z","x");
    const before=routes(db,"a");
    expect(await compactPreparedGraph(db,async()=>{})).toEqual({beforeNodes:7,beforePhysicalEdges:7,nodes:4,physicalEdges:4});
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
  it("bounds long corridors and rolls back cancellation without losing source rows",async()=>{
    const {db,node,add}=fixture();for(let index=0;index<=2050;index++)node(`n${String(index).padStart(4,"0")}`);
    for(let index=0;index<2050;index++)add(`n${String(index).padStart(4,"0")}`,`n${String(index+1).padStart(4,"0")}`);
    let checks=0;
    await expect(compactPreparedGraph(db,async()=>{if(++checks===4)throw new Error("cancelled");})).rejects.toThrow("cancelled");
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()!.n).toBe(2051);
    const counts=await compactPreparedGraph(db,async()=>{});
    expect(counts.nodes).toBe(3);expect(counts.physicalEdges).toBe(2);
    expect(db.prepare("SELECT max(json_array_length(elevation_profile)) AS n FROM edges").get()!.n).toBe(2049);
    integrity(db);
  });
});
