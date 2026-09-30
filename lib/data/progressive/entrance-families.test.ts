import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { rectangle } from "@/lib/coverage/geometry";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { createPreparedSchema } from "../sqlite-writer";
import { auditPreparedGraph } from "../prepared-audit";
import { createEntranceFamilySchema } from "./entrance-families";
import { writeProgressiveTopology } from "./topology";

const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const source={id:"fixture",authority:"Fixture",dataset:"Trails",version:"1",retrievedAt:"2026-09-29T00:00:00Z",url:"https://example.invalid/trails",license:"CC0",contentHash:`sha256:${"0".repeat(64)}`};
const expected={id:"fixture",geometry:rectangle([-2,-2,2,2]),sources:[source]};

function fixture({unknown=false,chain=false}:{unknown?:boolean;chain?:boolean}={}) {
  const db=new DatabaseSync(":memory:");databases.push(db);createPreparedSchema(db);db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO metadata VALUES('schemaVersion','7'),('releaseId','fixture')").run();
  db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?)").run(...Object.values(source));
  let nodeKey=0,physicalKey=0,edgeKey=0;
  const node=(id:string,lon:number,lat=0)=>{
    const key=++nodeKey;db.prepare("INSERT INTO nodes VALUES(?,?,?,?,0,'[]')").run(id,key,lon,lat);
    db.prepare("INSERT INTO node_spatial VALUES(?,?,?,?,?)").run(key,lon,lon,lat,lat);
  };
  const access=(id:string,state=unknown?"unknown":"public")=>{
    db.prepare("INSERT INTO access_points VALUES(?,?,?,'trailhead',?,'high',NULL,'[\"fixture\"]',1,1,1,1,0,1,'fixture','street',NULL,NULL,NULL)").run(`access-${id}`,id,id,state);
  };
  const add=(a:string,b:string,{length=60,oneway=false,flags=[],state=unknown?"unknown":"public"}:{length?:number;oneway?:boolean;flags?:string[];state?:string}={})=>{
    const from=db.prepare("SELECT * FROM nodes WHERE id=?").get(a)!,to=db.prepare("SELECT * FROM nodes WHERE id=?").get(b)!;
    const geometry=[[Number(from.lon),Number(from.lat)],[Number(to.lon),Number(to.lat)]];
    const canonical=canonicalTopologyJson(geometry),reverse=canonicalTopologyJson([...geometry].reverse());
    const pk=++physicalKey;
    db.prepare("INSERT INTO physical_edges VALUES(?,?,?,?,?)").run(pk,`physical-${pk}`,Math.min(Number(from.node_key),Number(to.node_key)),Math.max(Number(from.node_key),Number(to.node_key)),topologySha256(canonical<reverse?canonical:reverse));
    for(const backwards of oneway?[false]:[false,true]) {
      const key=++edgeKey;
      db.prepare("INSERT INTO edges VALUES(?,?,?,?,?,?,?,0,0,0,NULL,?,?, 'trail','[\"fixture\"]',?)").run(`edge-${key}`,key,pk,backwards?b:a,backwards?a:b,JSON.stringify(backwards?[...geometry].reverse():geometry),length,JSON.stringify([[0,0],[length,0]]),state,JSON.stringify(flags));
      db.prepare("INSERT INTO edge_spatial VALUES(?,?,?,?,?)").run(key,Math.min(Number(from.lon),Number(to.lon)),Math.max(Number(from.lon),Number(to.lon)),Math.min(Number(from.lat),Number(to.lat)),Math.max(Number(from.lat),Number(to.lat)));
    }
    return pk;
  };
  for(const [id,lon,lat] of [["a",0,0],["b",0.0006,0],["j",0.0003,0.0006],["c",0.0003,0.003],["d",0.003,0.003],["e",0.003,0.006]] as const)node(id,lon,lat);
  access("a");access("b");
  if(chain){node("middle",0.0001,0.0003);add("a","middle",{length:36.05});add("middle","j",{length:40});}
  else add("a","j",{length:76.05});
  add("b","j",{length:68.23});add("j","c",{length:400});add("c","d",{length:500});add("d","e",{length:500});add("e","c",{length:500});
  const families=()=>db.prepare("SELECT * FROM access_entrance_families ORDER BY profile,access_point_id").all();
  return {db,node,access,add,families};
}

describe("build-time shared entrance bridge arms",()=>{
  it("records short arms at one junction and preserves all graph/start records and metrics",async()=>{
    const {db,families}=fixture({chain:true});
    const before=["nodes","edges","physical_edges"].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const starts=db.prepare("SELECT id,node_id,name,access_state FROM access_points ORDER BY id").all();
    await writeProgressiveTopology(db);
    const found=families();expect(found).toHaveLength(4);
    for(const profile of ["known","inclusive"]){
      const members=found.filter(row=>row.profile===profile);
      expect(new Set(members.map(row=>row.family_id)).size).toBe(1);
      expect(members.map(row=>[row.access_point_id,row.junction_node_id,row.approach_distance_m])).toEqual([["access-a","j",76.05],["access-b","j",68.23]]);
    }
    expect(found[0]!.family_id).not.toBe(found[2]!.family_id);
    expect(["nodes","edges","physical_edges"].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
    expect(db.prepare("SELECT id,node_id,name,access_state FROM access_points ORDER BY id").all()).toEqual(starts);
    expect(db.prepare("SELECT known_minimum_stem_m FROM access_points WHERE id='access-a'").get()!.known_minimum_stem_m).toBe(476.05);
    await auditPreparedGraph(db,expected,async()=>{});
    await writeProgressiveTopology(db);expect(families()).toEqual(found);
  });
  it("separates public-only and inclusive proofs without discarding unknown entrances",async()=>{
    const {db,families}=fixture({unknown:true});await writeProgressiveTopology(db);
    expect(families()).toHaveLength(2);expect(families().every(row=>row.profile==="inclusive")).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM access_points").get()!.n).toBe(2);
    await auditPreparedGraph(db,expected,async()=>{});
  });
  it("accepts three close leaf approaches only when one onward link remains",async()=>{
    const {db,node,access,add,families}=fixture();node("third",0.0004,0.0001);access("third");add("third","j");
    await writeProgressiveTopology(db);expect(families()).toHaveLength(6);
  });
  it.each(["loop","parallel","path split","multiple onward","one way","cross-SCC exit","different access","different approach access","long approach","non pedestrian","self loop","nearby disconnected"])("rejects %s rather than relying on proximity",async(kind)=>{
    const {db,node,add,families}=fixture();
    if(kind==="loop")add("a","b");
    if(kind==="parallel")add("a","j");
    if(kind==="path split")add("b","c");
    if(kind==="multiple onward"){node("exit",0.0004,0.0008);add("j","exit",{length:500});}
    if(kind==="one way")db.exec("DELETE FROM edges WHERE from_node='j' AND to_node='b'");
    if(kind==="cross-SCC exit"){node("exit",0.0002);add("a","exit",{oneway:true});}
    if(kind==="different access")db.exec("UPDATE access_points SET access_state='unknown' WHERE node_id='b'");
    if(kind==="different approach access")db.exec("UPDATE edges SET access_state='unknown' WHERE from_node='b' OR to_node='b'");
    if(kind==="long approach")db.exec("UPDATE edges SET length_m=251 WHERE from_node='a' OR to_node='a'");
    if(kind==="non pedestrian")db.exec(`UPDATE edges SET flags='["FOOT:NO"]' WHERE from_node='b' OR to_node='b'`);
    if(kind==="self loop")add("a","a");
    if(kind==="nearby disconnected"){
      db.exec("DELETE FROM edges WHERE from_node='b' OR to_node='b'; DELETE FROM physical_edges WHERE stable_physical_id='physical-2'");
      node("other",0.0005,0.0006);add("b","other",{length:68.23});add("other","d");add("other","e");
    }
    await writeProgressiveTopology(db);expect(families()).toEqual([]);
  });
  it("refuses spatial chaining and a subset that would leave a second onward branch",async()=>{
    const {db,node,access,add,families}=fixture();
    // A-B and B-third are below 100 m; A-third exceeds the fixed bound.
    db.exec("UPDATE nodes SET lon=0.00072 WHERE id='b'");node("third",0.00144);access("third");add("third","j");
    await writeProgressiveTopology(db);expect(families()).toEqual([]);
  });
  it("cancels outside transactions, clears scratch work and retries on the same connection",async()=>{
    const {db,families}=fixture();let cancelled=false;
    await expect(writeProgressiveTopology(db,async()=>{
      expect(db.isTransaction).toBe(false);
      if(!cancelled&&db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='entrance_arms'").get()) {cancelled=true;throw new Error("cancel family work");}
    })).rejects.toThrow("cancel family work");
    expect(db.isTransaction).toBe(false);expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
    await writeProgressiveTopology(db);expect(families()).toHaveLength(4);
  });
  it("bounds traces even when zero-length source segments never exhaust the distance limit",async()=>{
    const {db,node,add,families}=fixture();
    db.exec("DELETE FROM edges WHERE physical_edge_key=1; DELETE FROM physical_edges WHERE physical_edge_key=1");
    let previous="a";
    for(let index=0;index<4096;index++) {
      const id=`short-${index}`;node(id,0.0001);add(previous,id,{length:0});previous=id;
    }
    add(previous,"j",{length:76.05});
    await writeProgressiveTopology(db);expect(families()).toEqual([]);
  });
});

describe("optional entrance-family extension audit",()=>{
  it("accepts legacy schema-7 graphs without the extension",async()=>{
    const {db}=fixture();await auditPreparedGraph(db,expected,async()=>{});
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='access_entrance_families'").get()).toBeUndefined();
  });
  it.each(["singleton","different junction","mixed access","dangling access","dangling junction","invalid profile","negative distance","overlong distance","infinite distance","invalid family id","repeated member"])("rejects %s in an unconstrained producer table",async(kind)=>{
    const {db}=fixture();
    db.exec("CREATE TABLE access_entrance_families(profile TEXT,access_point_id TEXT,family_id TEXT,junction_node_id TEXT,approach_distance_m REAL)");
    const family=`entrance-family:${"a".repeat(64)}`;
    const insert=db.prepare("INSERT INTO access_entrance_families VALUES(?,?,?,?,?)");
    insert.run("inclusive","access-a",family,"j",76.05);insert.run("inclusive","access-b",family,"j",68.23);
    if(kind==="singleton")db.exec("DELETE FROM access_entrance_families WHERE access_point_id='access-b'");
    if(kind==="different junction")db.exec("UPDATE access_entrance_families SET junction_node_id='c' WHERE access_point_id='access-b'");
    if(kind==="mixed access")db.exec("UPDATE access_points SET access_state='unknown' WHERE id='access-b'");
    if(kind==="dangling access")db.exec("UPDATE access_entrance_families SET access_point_id='missing' WHERE access_point_id='access-b'");
    if(kind==="dangling junction")db.exec("UPDATE access_entrance_families SET junction_node_id='missing'");
    if(kind==="invalid profile")db.exec("UPDATE access_entrance_families SET profile='bogus'");
    if(kind==="negative distance")db.exec("UPDATE access_entrance_families SET approach_distance_m=-1");
    if(kind==="overlong distance")db.exec("UPDATE access_entrance_families SET approach_distance_m=251");
    if(kind==="infinite distance")db.prepare("UPDATE access_entrance_families SET approach_distance_m=?").run(Infinity);
    if(kind==="invalid family id")db.exec("UPDATE access_entrance_families SET family_id='untrusted'");
    if(kind==="repeated member")insert.run("inclusive","access-a",`entrance-family:${"b".repeat(64)}`,"j",76.05);
    await expect(auditPreparedGraph(db,expected,async()=>{})).rejects.toThrow(/entrance family/);
  });
  it("creates foreign keys and checks even when no arms qualify",async()=>{
    const {db}=fixture();createEntranceFamilySchema(db);
    expect(()=>db.prepare("INSERT INTO access_entrance_families VALUES('invalid','access-a','family','j',76)").run()).toThrow();
    expect(()=>db.prepare("INSERT INTO access_entrance_families VALUES('known','missing','family','j',76)").run()).toThrow();
    expect(()=>db.prepare("INSERT INTO access_entrance_families VALUES('known','access-a','family','missing',76)").run()).toThrow();
    expect(()=>db.prepare("INSERT INTO access_entrance_families VALUES('known','access-a','family','j',251)").run()).toThrow();
  });
});
