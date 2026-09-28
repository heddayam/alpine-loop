import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
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
