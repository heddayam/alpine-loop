import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AreaGeometry } from "../area-geometry";
import type { NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";
import { openProgressiveGraphStore } from "./store";

it("merges overlapping source provenance without duplicating context or weakening contradictions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "network-context-"));
  const store = openProgressiveGraphStore({ stagingPath: path.join(root, "stage.sqlite"), buildIdentity: "fixture" });
  const node: NormalizedNode = { id: "a", externalId: "node/1", lon: 1, lat: 2, elevationM: null, flags: [], sourceRefs: ["west"] };
  const way: NormalizedWay = { id: "road", externalId: "way/1", nodeIds: ["a", "b"], coordinates: [[1, 2], [2, 2]], name: null, accessState: "public", bidirectional: true, edgeClass: "street", flags: [], sourceRefs: ["west"] };
  const evidence: NormalizedPortalEvidence = { id: "parking", externalId: "node/1", kind: "parking", name: null, nodeIds: ["a"], coordinates: [[1, 2]], accessState: "public", sourceRefs: ["west"] };
  try {
    store.putNode(node);
    store.setNodeElevation(node.id, 120);
    store.putNode({ ...node, sourceRefs: ["east"] });
    store.putWay(way);
    store.putWay({ ...way, sourceRefs: ["east", "west"] });
    store.putPortalEvidence(evidence);
    store.putPortalEvidence({ ...evidence, sourceRefs: ["east"] });
    for (const table of ["nodes", "ways", "evidence"]) {
      const rows = store.database.prepare(`SELECT record FROM ${table}`).all();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]!.record)).sourceRefs).toEqual(["east", "west"]);
    }
    expect([...store.iterateNodes()][0]!.elevationM).toBe(120);
    expect(store.database.prepare("SELECT count(*) AS n FROM way_nodes").get()!.n).toBe(2);
    expect(store.database.prepare("SELECT count(*) AS n FROM evidence_points").get()!.n).toBe(1);
    expect(() => store.putNode({ ...node, lon: 1.1 })).toThrow("Conflicting");
    expect(() => store.putNode({ ...node, elevationM: 121 })).toThrow("Conflicting elevation");
    expect(() => store.putWay({ ...way, accessState: "private" })).toThrow("Conflicting");
    expect(() => store.putPortalEvidence({ ...evidence, coordinates: [[1.1, 2]] })).toThrow("Conflicting");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("reuses fixed import statements across new identities and overlapping replays", () => {
  const store = openProgressiveGraphStore({ stagingPath: ":memory:", buildIdentity: "statement-fixture" });
  const prepare = vi.spyOn(store.database, "prepare");
  const put = (index: number, source: string) => {
    const id = String(index);
    const node: NormalizedNode = { id, externalId: `node/${id}`, lon: index, lat: 2, elevationM: null, flags: [], sourceRefs: [source] };
    store.putNode(node);
    store.putNode({ ...node, elevationM: 120 });
    store.setNodeElevation(id, 120);
    store.putWay({ id, externalId: `way/${id}`, nodeIds: [id], coordinates: [[index, 2]], name: null, accessState: "public", bidirectional: true, flags: [], sourceRefs: [source] });
    store.putPortalEvidence({ id, externalId: `node/${id}`, kind: "parking", name: null, nodeIds: [id], coordinates: [], accessState: "public", sourceRefs: [source] });
    store.putBuilding([index, 2]);
  };
  try {
    put(0, "west");
    put(0, "east");
    const prepared = prepare.mock.calls.length;
    expect(prepared).toBeGreaterThan(0);
    for (let index = 1; index <= 25; index++) {
      put(index, "west");
      put(index, "east");
      put(index, "east");
    }
    expect(prepare).toHaveBeenCalledTimes(prepared);
    expect([...store.iterateNodes()]).toHaveLength(26);
    expect([...store.iterateNodes()].every((node) => node.elevationM === 120 && node.sourceRefs.join() === "east,west")).toBe(true);
  } finally {
    prepare.mockRestore();
    store.close();
  }
});

it("rolls back imports and reuses statements without retaining rolled-back records", () => {
  const store = openProgressiveGraphStore({ stagingPath: ":memory:", buildIdentity: "rollback-fixture" });
  const node: NormalizedNode = { id: "a", externalId: "node/a", lon: 1, lat: 2, elevationM: null, flags: [], sourceRefs: ["west"] };
  const put = () => {
    store.putNode({ ...node, elevationM: 120, sourceRefs: ["east"] });
    store.putNode({ ...node, id: "b", externalId: "node/b", lon: 2 });
    store.putWay({ id: "trail", externalId: "way/trail", nodeIds: ["a", "b"], coordinates: [[1, 2], [2, 2]], name: null, accessState: "public", bidirectional: true, flags: [], sourceRefs: ["west"] });
    store.putPortalEvidence({ id: "parking", externalId: "node/a", kind: "parking", name: null, nodeIds: ["a"], coordinates: [], accessState: "public", sourceRefs: ["west"] });
    store.putBuilding([1, 2]);
  };
  try {
    store.putNode(node);
    expect(() => store.transaction(() => { put(); throw new Error("interrupted"); })).toThrow("interrupted");
    expect([...store.iterateNodes()]).toEqual([node]);
    const counts = { nodes_spatial: 1, ways: 0, way_nodes: 0, evidence: 0, evidence_points: 0, evidence_spatial: 0, buildings: 0, building_spatial: 0 };
    for (const [table, count] of Object.entries(counts)) {
      expect(store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(count);
    }
    store.transaction(put);
    store.transaction(put);
    expect([...store.iterateNodes()][0]).toEqual({ ...node, elevationM: 120, sourceRefs: ["east", "west"] });
    expect([...store.iterateNodes()]).toHaveLength(2);
    for (const table of ["ways", "evidence", "evidence_points", "evidence_spatial", "buildings", "building_spatial"]) {
      expect(store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(1);
    }
    expect(store.database.prepare("SELECT count(*) AS n FROM way_nodes").get()!.n).toBe(2);
    expect(() => store.putNode({ ...node, elevationM: 121 })).toThrow("Conflicting elevation");
  } finally { store.close(); }
});

it("repairs incomplete derived rows after reopening and resolves evidence when nodes arrive later", () => {
  const root = mkdtempSync(path.join(tmpdir(), "network-resume-"));
  const options = { stagingPath: path.join(root, "stage.sqlite"), buildIdentity: "resume-fixture" };
  let store = openProgressiveGraphStore(options);
  const node: NormalizedNode = { id: "a", externalId: "node/a", lon: 1, lat: 2, elevationM: null, flags: [], sourceRefs: ["west"] };
  const way: NormalizedWay = { id: "trail", externalId: "way/trail", nodeIds: ["a", "b"], coordinates: [[1, 2], [2, 2]], name: null, accessState: "public", bidirectional: true, flags: [], sourceRefs: ["west"] };
  const evidence: NormalizedPortalEvidence = { id: "parking", externalId: "node/b", kind: "parking", name: null, nodeIds: ["b"], coordinates: [], accessState: "public", sourceRefs: ["west"] };
  try {
    store.putNode(node);
    store.putWay(way);
    store.putBuilding([1, 2]);
    store.putPortalEvidence(evidence);
    expect(store.database.prepare("SELECT count(*) AS n FROM evidence_points").get()!.n).toBe(0);
    store.database.exec("DELETE FROM nodes_spatial; DELETE FROM way_nodes WHERE ordinal=1; DELETE FROM building_spatial");
    store.close();
    store = openProgressiveGraphStore(options);
    store.putNode(node);
    store.putWay(way);
    store.putBuilding([1, 2]);
    expect(store.database.prepare("SELECT count(*) AS n FROM nodes_spatial").get()!.n).toBe(1);
    expect(store.database.prepare("SELECT node_id,ordinal FROM way_nodes ORDER BY ordinal").all()).toEqual([{ node_id: "a", ordinal: 0 }, { node_id: "b", ordinal: 1 }]);
    expect(store.database.prepare("SELECT count(*) AS n FROM building_spatial").get()!.n).toBe(1);
    store.putNode({ ...node, id: "b", externalId: "node/b", lon: 2 });
    store.putPortalEvidence(evidence);
    store.putPortalEvidence(evidence);
    expect(store.database.prepare("SELECT lon,lat FROM evidence_points").all()).toEqual([{ lon: 2, lat: 2 }]);
    expect(store.database.prepare("SELECT count(*) AS n FROM evidence_spatial").get()!.n).toBe(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["unknown", "private"] as const)("keeps portal ranking accurate with %s links and reusable statements", async (state) => {
  const store=openProgressiveGraphStore({stagingPath:":memory:",buildIdentity:"portal-fixture"});
  try {
    for(const [index,id] of ["a","b","c","road"].entries())store.putNode({id,externalId:`node/${id}`,lon:index*.001,lat:0,elevationM:0,flags:[],sourceRefs:["fixture"]});
    store.putWay({id:"road",externalId:"way/road",nodeIds:["road","a"],coordinates:[[.003,0],[0,0]],name:null,accessState:"public",bidirectional:true,edgeClass:"street",flags:[],sourceRefs:["fixture"]});
    for(const [index,accessState] of ["public",state].entries()) {
      const from=index?"b":"a",to=index?"c":"b";
      const coordinates=[index? [.001,0] as const:[0,0] as const,index?[.002,0] as const:[.001,0] as const];
      store.putWay({id:`trail-${index}`,externalId:`way/${index}`,nodeIds:[from,to],coordinates,name:"Trail",accessState:accessState as "public"|"unknown"|"private",bidirectional:false,edgeClass:"trail",flags:[],sourceRefs:["fixture"]});
      store.putEdge({id:`edge-${index}`,stablePhysicalId:`physical-${index}`,fromNode:from,toNode:to,geometry:coordinates,lengthM:100,gainM:0,lossM:0,maxElevationM:0,maxSustainedGradePct:0,accessState:accessState as "public"|"unknown"|"private",edgeClass:"trail",flags:[],sourceRefs:["fixture"]});
    }
    const coverage:AreaGeometry={type:"Polygon",coordinates:[[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]]};
    for(let pass=0;pass<2;pass++) {
      expect(await store.derivePortals(coverage)).toBe(1);
      const point=JSON.parse(String(store.database.prepare("SELECT record FROM derived_portals").get()!.record));
      expect(point).toMatchObject({nodeId:"a",knownConnectivity:2,inclusiveConnectivity:state==="unknown"?3:2,knownOutDegree:1,inclusiveOutDegree:1,reachableTrailKm:.2});
    }
  } finally {store.close();}
});
