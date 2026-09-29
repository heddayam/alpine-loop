import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { pruneWalkingGraph, qualifyMountainStarts } from "./prune";

const databases: DatabaseSync[] = [];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());});
function graph(nodes: Array<[string,number,number]>, links: Array<[string,string,string,number]>, seeds = ["s"]) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY,lon REAL,lat REAL); CREATE TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT,to_node TEXT,length_m REAL,approach_link INTEGER NOT NULL DEFAULT 1,core_hiking INTEGER NOT NULL DEFAULT 1); CREATE TEMP TABLE sparse_start_nodes(node_id TEXT PRIMARY KEY)");
  const addNode=db.prepare("INSERT INTO nodes VALUES (?,?,?)"),addEdge=db.prepare("INSERT INTO eligible_segments(id,from_node,to_node,length_m) VALUES (?,?,?,?)");
  seeds.forEach(id=>db.prepare("INSERT INTO sparse_start_nodes VALUES (?)").run(id));
  nodes.forEach(row=>addNode.run(...row));links.forEach(row=>addEdge.run(...row));return db;
}
const kept=(db:DatabaseSync)=>db.prepare("SELECT id FROM eligible_segments ORDER BY id").all().map(row=>row.id);
it("keeps asymmetric loops using undirected distance and removes disconnected support trails",async()=>{
  const db=graph([["s",0,0],["a",1,0],["b",2,0],["island",3,0],["end",4,0]],
    [["sa","s","a",35],["ab","a","b",5],["bs","b","s",10],["island","island","end",1]]);
  const result=await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  // A is 35 forward units from S, but only 15 along the reversed return.
  expect(kept(db)).toEqual(["ab","bs","sa"]);
  expect(result).toMatchObject({candidateSegments:4,retainedSegments:3,seedNodes:1});
});
it("drops an expensive edge even when both endpoints are near starts",async()=>{
  const db=graph([["s",0,0],["a",1,0],["b",2,0],["far",3,0]],
    [["sa","s","a",10],["sb","s","b",10],["expensive","a","b",31],["far","a","far",16]]);
  await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["sa","sb"]);
});
it("seeds only frozen eligible starts, retains the exact distance boundary and zero-length links",async()=>{
  const db=graph([["s",0,0],["second",.05,0],["a",1,0],["b",2,0]],
    [["sa","s","a",25],["secondb","second","b",25],["zero","s","second",0]],["s","second"]);
  await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["sa","secondb","zero"]);
});
it.each([qualifyMountainStarts,pruneWalkingGraph])("fails before allocating an over-budget graph and honors cancellation (%#)",async(run)=>{
  const db=graph([["s",0,0],["a",1,0]],[["sa","s","a",1]]);
  await expect(run(db,50,async()=>{},1)).rejects.toThrow("memory budget");
  expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name='pruning_nodes'").get()).toBeUndefined();
  const second=graph([["s",0,0],["a",1,0]],[["sa","s","a",1]]);
  const stop=vi.fn(async()=>{throw new Error("cancelled");});
  await expect(run(second,50,stop,32*1024**2)).rejects.toThrow("cancelled");
});
it("rejects a region with no potentially eligible start node",async()=>{
  const db=graph([["s",1,0],["a",2,0]],[["sa","s","a",1]],[]);
  await expect(pruneWalkingGraph(db,50,async()=>{},32*1024**2)).rejects.toThrow("connect to the selected region");
});

it("does not seed unqualified trail nodes inside the same geographic area",async()=>{
  const db=graph([["s",0,0],["a",.01,0],["dense",.02,0],["b",.03,0]],
    [["sparse","s","a",1],["dense","dense","b",1]]);
  await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["sparse"]);
});

it("preserves unmarked valley approaches at the distance bound and rejects disconnected lowland starts",async()=>{
  const db=graph([["s",0,0],["a",1,0],["b",2,0],["lowland",0,0],["end",1,0],["far",3,0]],
    [["approach","s","a",25],["mountain","a","b",1],["low","lowland","end",1],["too-far","far","a",26]],["s","lowland","far"]);
  db.exec("UPDATE eligible_segments SET core_hiking=0 WHERE id!='mountain'; CREATE TEMP TABLE sparse_portal_candidates(node_id TEXT PRIMARY KEY); INSERT INTO sparse_portal_candidates SELECT node_id FROM sparse_start_nodes");
  const result=await qualifyMountainStarts(db,50,async()=>{},32*1024**2);
  expect(result).toMatchObject({seedNodes:1,terrainExcludedAccessPoints:2});
  expect(db.prepare("SELECT node_id FROM sparse_portal_candidates").all()).toEqual([{node_id:"s"}]);
  expect(db.prepare("SELECT node_id FROM terrain_excluded_start_nodes ORDER BY node_id").all()).toEqual([{node_id:"far"},{node_id:"lowland"}]);
  expect(kept(db)).toEqual(["approach","low","mountain","too-far"]);
  await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["approach"]);
});

it("does not qualify a start from possible walking connectors alone",async()=>{
  const db=graph([["s",0,0],["a",1,0]],[["connector","s","a",1]]);
  db.exec("UPDATE eligible_segments SET core_hiking=0");
  await expect(qualifyMountainStarts(db,50,async()=>{},32*1024**2)).rejects.toThrow("connect to mountain hiking trails");
});

it("connects possible footways to mountain tracks but excludes ordinary-road-only and missing-graph starts",async()=>{
  const db=graph([["s",0,0],["a",1,0],["b",2,0],["road",3,0],["missing",4,0]],
    [["track","a","b",1],["possible-footway","s","a",5],["road","road","a",1]],["s","road","missing"]);
  db.exec("UPDATE eligible_segments SET core_hiking=0 WHERE id!='track'; UPDATE eligible_segments SET approach_link=0 WHERE id='road'");
  const result=await qualifyMountainStarts(db,50,async()=>{},32*1024**2);
  expect(result).toMatchObject({candidateNodes:3,candidateSegments:2,seedNodes:1,terrainExcludedAccessPoints:2});
  expect(db.prepare("SELECT node_id FROM sparse_start_nodes").all()).toEqual([{node_id:"s"}]);
  expect(db.prepare("SELECT node_id FROM terrain_excluded_start_nodes ORDER BY node_id").all()).toEqual([{node_id:"missing"},{node_id:"road"}]);
  await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["possible-footway","road","track"]);
});

it("rejects all candidates when the qualification graph has no approach links",async()=>{
  const db=graph([["s",0,0],["a",1,0]],[["road","s","a",1]]);
  db.exec("UPDATE eligible_segments SET approach_link=0,core_hiking=0");
  await expect(qualifyMountainStarts(db,50,async()=>{},32*1024**2)).rejects.toThrow("connect to mountain hiking trails");
  expect(db.prepare("SELECT node_id FROM terrain_excluded_start_nodes").all()).toEqual([{node_id:"s"}]);
});

it("retains later-imported loops heading away from the core without admitting new starts",async()=>{
  const db=graph([["s",-25,0],["core",0,0],["peak",1,0],["away",-45,0],["turn",-45,1]],
    [["approach","s","core",25],["mountain","core","peak",1]]);
  db.exec("UPDATE eligible_segments SET core_hiking=0 WHERE id='approach'");
  await qualifyMountainStarts(db,50,async()=>{},32*1024**2);
  // Expansion adds route support beyond the first 25-unit core envelope.
  db.exec(`INSERT INTO eligible_segments VALUES
    ('out','s','away',20,0,0),('across','away','turn',1,0,0),('back','turn','s',21,0,0)`);
  const result=await pruneWalkingGraph(db,50,async()=>{},32*1024**2);
  expect(result.seedNodes).toBe(1);
  expect(kept(db)).toEqual(["across","approach","back","out"]);
  expect(db.prepare("SELECT node_id FROM sparse_start_nodes").all()).toEqual([{node_id:"s"}]);
});

it("cleans up a qualification cancelled during graph loading without changing frozen candidates",async()=>{
  const nodes: Array<[string,number,number]>=Array.from({length:1002},(_,i)=>[String(i),i,0]);
  const links: Array<[string,string,string,number]>=Array.from({length:1001},(_,i)=>[String(i),String(i),String(i+1),1]);
  const db=graph(nodes,links,["0"]);
  let calls=0;
  await expect(qualifyMountainStarts(db,50,async()=>{if(++calls===2)throw new Error("cancelled");},32*1024**2)).rejects.toThrow("cancelled");
  expect(db.prepare("SELECT node_id FROM sparse_start_nodes").all()).toEqual([{node_id:"0"}]);
  expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name='pruning_nodes'").get()).toBeUndefined();
});
