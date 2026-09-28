import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { rectangle } from "./geometry";
import { pruneWalkingGraph } from "./prune";

const databases: DatabaseSync[] = [];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());});
function graph(nodes: Array<[string,number,number]>, links: Array<[string,string,string,number]>) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY,lon REAL,lat REAL); CREATE TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT,to_node TEXT,length_m REAL)");
  const addNode=db.prepare("INSERT INTO nodes VALUES (?,?,?)"),addEdge=db.prepare("INSERT INTO eligible_segments VALUES (?,?,?,?)");
  nodes.forEach(row=>addNode.run(...row));links.forEach(row=>addEdge.run(...row));return db;
}
const core=rectangle([-.1,-.1,.1,.1]);
const kept=(db:DatabaseSync)=>db.prepare("SELECT id FROM eligible_segments ORDER BY id").all().map(row=>row.id);
it("keeps asymmetric loops using undirected distance and removes disconnected support trails",async()=>{
  const db=graph([["s",0,0],["a",1,0],["b",2,0],["island",3,0],["end",4,0]],
    [["sa","s","a",35],["ab","a","b",5],["bs","b","s",10],["island","island","end",1]]);
  const result=await pruneWalkingGraph(db,core,50,async()=>{},32*1024**2);
  // A is 35 forward units from S, but only 15 along the reversed return.
  expect(kept(db)).toEqual(["ab","bs","sa"]);
  expect(result).toMatchObject({candidateSegments:4,retainedSegments:3,seedNodes:1});
});
it("drops an expensive edge even when both endpoints are near starts",async()=>{
  const db=graph([["s",0,0],["a",1,0],["b",2,0],["far",3,0]],
    [["sa","s","a",10],["sb","s","b",10],["expensive","a","b",31],["far","a","far",16]]);
  await pruneWalkingGraph(db,core,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["sa","sb"]);
});
it("seeds every core trail node, retains the exact distance boundary and zero-length links",async()=>{
  const db=graph([["s",0,0],["second",.05,0],["a",1,0],["b",2,0]],
    [["sa","s","a",25],["secondb","second","b",25],["zero","s","second",0]]);
  await pruneWalkingGraph(db,core,50,async()=>{},32*1024**2);
  expect(kept(db)).toEqual(["sa","secondb","zero"]);
});
it("fails before allocating an over-budget graph and honors cancellation",async()=>{
  const db=graph([["s",0,0],["a",1,0]],[["sa","s","a",1]]);
  await expect(pruneWalkingGraph(db,core,50,async()=>{},1)).rejects.toThrow("memory budget");
  const second=graph([["s",0,0],["a",1,0]],[["sa","s","a",1]]);
  const stop=vi.fn(async()=>{throw new Error("cancelled");});
  await expect(pruneWalkingGraph(second,core,50,stop,32*1024**2)).rejects.toThrow("cancelled");
});
it("rejects a region with no potentially eligible start node",async()=>{
  const db=graph([["s",1,0],["a",2,0]],[["sa","s","a",1]]);
  await expect(pruneWalkingGraph(db,core,50,async()=>{},32*1024**2)).rejects.toThrow("connect to the selected region");
});
