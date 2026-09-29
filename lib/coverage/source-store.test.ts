import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoverageSourceStore, sourceStoreFileName, type CoverageContextEntry } from "./source-store";
import type { SourceSnapshot } from "@/lib/data/adapters";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { rectangle, unionCoverage } from "./geometry";

vi.mock("./source-filter", () => ({ filteredSourceLines: () => { throw new Error("Unexpected source read"); } }));
const source: SourceSnapshot = { id: "fixture", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24", url: "https://example.invalid/fixture", license: "fixture", contentHash: `sha256:${"1".repeat(64)}`, localPath: "/offline-fixture.osm.pbf" };
const area = rectangle([-1, -1, 4, 2]);
const fixtures = [
  "n1 T x0 y0", "n2 T x1 y0", "n3 T x1 y1", "n4 T x0 y1",
  "n5 Thighway=trailhead,name=Trailhead x2 y0", "n6 T x3 y0",
  "w10 Thighway=path,foot=private Nn1,n2",
  "w11 Thighway=footway Nn2,n5", "w12 Thighway=footway Nn5,n6",
  "w13 Thighway=footway,footway=sidewalk Nn2,n3",
  "w20 T Nn1,n2,n3", "w21 T Nn1,n4,n3",
  "r30 Ttype=multipolygon,building=yes Mw20@outer,w21@outer",
];
async function* lines(input = fixtures) { yield* input; }
const stores: CoverageSourceStore[] = [];
const directories: string[] = [];
const make = (geometry: AreaGeometry = area, file = ":memory:") => {
  const store = new CoverageSourceStore(file, source, geometry); stores.push(store); return store;
};
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("compact coverage source", () => {
  it("retains local trails and context without promotion or global joins", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([...fixtures,
      "w40 Thighway=residential Nn1,n3", "w41 Thighway=footway Nn3,n4",
      "w42 Tbuilding=yes Nn1,n2,n3,n4,n1",
    ]) });
    expect([...store.ways(area)].map(({way})=>way.externalId)).toEqual(["way/10", "way/11", "way/12", "way/13", "way/40", "way/41"]);
    expect([...store.ways(area)][0]!.way.accessState).toBe("private");
    expect([...store.ways(area)].find(({way})=>way.externalId==="way/41")?.way).toMatchObject({edgeClass:"trail",flags:expect.arrayContaining(["possible-walking-link"])});
    expect([...store.ways(area)].find(({way})=>way.externalId==="way/13")?.way.edgeClass).toBe("sidewalk");
    expect([...store.evidence(area)].map(item=>item.externalId)).toEqual(["node/5"]);
    expect([...store.buildings(area)]).toHaveLength(2);
    expect(store.db.prepare("SELECT count(*) AS n FROM nodes").get()?.n).toBe(1);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='metrics'").all()).toEqual([]);
    expect(store.db.prepare("SELECT count(*) AS n FROM inventory").get()?.n).toBe(0);
    expect(store.db.prepare("SELECT name FROM sqlite_temp_master WHERE name IN ('import_nodes','source_ways','refs','promotion_frontier')").all()).toEqual([]);
  });

  it("preserves directions, explicit access overrides, and permitted road walking connectors", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([
      ...fixtures.slice(0,6), "w10 Thighway=path,oneway:foot=-1,access=private,foot=yes Nn1,n2",
      "w20 Thighway=service,foot=permissive Nn2,n3", "w30 Thighway=residential,name=Forest%20%Trail Nn3,n4",
    ]) });
    const ways = [...store.ways(area)].map(({way})=>way);
    expect(ways[0]).toMatchObject({ nodeIds: ["osm-node-2","osm-node-1"], bidirectional:false, accessState:"public" });
    expect(ways.map(way=>way.edgeClass)).toEqual(["trail","trail","trail"]);
  });

  it.each(["stream", "integrity"])("rebuilds an interrupted %s phase without trusting partial data", async (phase) => {
    const store = make();
    let stage = "stream";
    async function* failed() { yield* fixtures.slice(0,6); throw new Error("paused"); }
    await expect(store.import(async () => {
      if ((phase === "integrity" && stage === "integrity-check")) throw new Error("paused");
    }, { lines: phase === "stream" ? failed() : lines(), onStage: async value => { stage=value; } })).rejects.toThrow("paused");
    expect(()=>[...store.ways(area)]).toThrow("completed verified import");
    expect(()=>[...store.evidence(area)]).toThrow("completed verified import");
    expect(()=>[...store.buildings(area)]).toThrow("completed verified import");
    expect(()=>[...store.context(area)]).toThrow("completed verified import");
    store.db.exec("INSERT OR REPLACE INTO ways(id,kind) VALUES('999','trail')");
    await store.import(async () => {}, { lines: lines() });
    expect([...store.ways(area)].map(({way})=>way.externalId)).toEqual(["way/10","way/11","way/12","way/13"]);
  });

  it("rejects changed immutable data and missing completion metadata", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    await store.import(async () => {});
    store.db.exec("UPDATE ways SET coordinates='[[99,99],[100,100]]' WHERE id='10'");
    await expect(store.import(async () => {})).rejects.toThrow("failed seal verification");
    expect(()=>[...store.ways(area)]).toThrow("completed verified import");
    store.db.exec("DELETE FROM receipts WHERE key='compact-import-v1'");
    await expect(store.import(async () => {})).rejects.toThrow("seal without a completion marker");
  });

  it("refuses a completion marker without its original seal", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    store.db.exec("DELETE FROM receipts WHERE key='compact-seal-v1'");
    await expect(store.import(async () => {})).rejects.toThrow("failed seal verification");
  });

  it("rebuilds interrupted or damaged derived spatial indexes on reuse", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    const expected = [...store.ways(area)];
    store.db.exec("DELETE FROM ways_spatial");
    await expect(store.import(async () => { throw new Error("paused"); })).rejects.toThrow("paused");
    expect(()=>[...store.ways(area)]).toThrow("completed verified import");
    await store.import(async () => {});
    expect([...store.ways(area)]).toEqual(expected);
  });

  it("uses exact spatial bounds after RTree lookup, with separate component envelopes", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([
      "n1 T x-121.0000001 y48", "n2 T x-120.9999999 y48",
      "n3 T x-120.9999998 y48", "n4 T x-120.9999997 y48",
      "n5 T x-121.009 y48", "n6 T x-121.008 y48",
      "w30 Thighway=path Nn3,n4", "w10 Thighway=path Nn1,n2", "w20 Thighway=path Nn5,n6",
    ]) });
    const bounds = rectangle([-121.0000001,47.9,-120.9999999,48.1]);
    expect([...store.ways(bounds,0)].map(({way})=>way.externalId)).toEqual(["way/10"]);
    expect([...store.ways(bounds)].map(({way})=>way.externalId)).toEqual(["way/10","way/20","way/30"]);
    const coverage = unionCoverage([bounds, rectangle([-121.01,47.9,-121.008,48.1])]);
    expect([...store.ways(coverage,0)].map(({way})=>way.externalId)).toEqual(["way/10","way/20"]);
  });

  it("retains access evidence and assembles reversed building fragments", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([...fixtures,
      "w40 Thighway=residential Nn1,n3", "w41 Tamenity=parking Nn1,n2",
    ]) });
    expect([...store.ways(area)].find(({way})=>way.externalId==="way/11")?.way.edgeClass).toBe("trail");
    expect([...store.ways(area)].find(({way})=>way.externalId==="way/40")?.way.edgeClass).toBe("street");
    expect([...store.evidence(area)].map(item=>item.externalId)).toEqual(["node/5","way/41"]);
    expect([...store.buildings(area)]).toEqual([[0.4,0.4]]);
    expect([...store.buildings(rectangle([2,2,3,3]))]).toEqual([]);
    expect(store.db.prepare("SELECT count(*) AS n FROM nodes").get()?.n).toBe(1);
  });

  it.each(["yes", "hut", "no"])("interprets building=%s consistently across nodes, ways and relations", async (building) => {
    const store = make();
    await store.import(async () => {}, { lines: lines([
      ...fixtures.slice(0,4),
      `n10 Tbuilding=${building} x2 y0`,
      `n11 Tbuilding=${building},highway=trailhead x2 y1`,
      `w20 Tbuilding=${building} Nn1,n2,n3,n4,n1`,
      `w21 Tbuilding=${building},highway=path Nn1,n2,n3,n4,n1`,
      `w22 Tbuilding=${building},amenity=parking Nn1,n2,n3,n4,n1`,
      "w40 T Nn1,n2,n3,n4,n1",
      `r30 Ttype=multipolygon,building=${building} Mw40@outer`,
    ]) });
    expect([...store.buildings(area)]).toEqual(building === "no" ? [] : [
      [2,0], [2,1], [0.4,0.4], [0.4,0.4], [0.4,0.4], [0.4,0.4],
    ]);
    // An explicit non-building can still be a trailhead, parking area or trail.
    expect([...store.evidence(area)].map(item=>item.externalId)).toEqual(["node/11", "way/22"]);
    expect([...store.ways(area)].map(({way})=>way.externalId)).toEqual(["way/21"]);
    if (building === "no") {
      expect(store.db.prepare("SELECT id FROM nodes ORDER BY id").all()).toEqual([{id:"11"}]);
      expect(store.db.prepare("SELECT id,kind FROM ways ORDER BY id").all()).toEqual([
        {id:"21",kind:"trail"}, {id:"22",kind:"evidence"},
      ]);
    }
  });

  it("seals malformed building diagnostics and rounds node buildings as before", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([
      "n1 Tbuilding=hut x0.123456 y0.654321", "r30 Ttype=multipolygon,building=yes Mw999@outer",
    ]) });
    expect([...store.buildings(area)]).toEqual([[0.12346,0.65432]]);
    expect(store.db.prepare("SELECT disposition FROM inventory WHERE id='relation/30'").get()?.disposition).toBe("unsupported");
    store.db.exec("UPDATE inventory SET reason='changed'");
    await expect(store.import(async () => {})).rejects.toThrow("failed seal verification");
  });

  it("streams mixed walking/building/evidence context once with the original memberships and ordering", async () => {
    const store=make();
    await store.import(async()=>{}, {lines:lines([
      ...fixtures,
      "n50 Tbuilding=hut,amenity=parking,information=trailhead,barrier=gate,tourism=information x-1.005 y0",
      "n51 Tbuilding=yes,highway=trailhead x-1.011 y0",
      "n52 Tbuilding=no,highway=trailhead x0.5 y0",
      "n53 T x4 y0", "n54 T x5 y0",
      "w40 Thighway=path,oneway:foot=-1,access=private,foot=yes,building=hut,amenity=parking,information=trailhead,barrier=gate,tourism=information,name=Shared Nn1,n2,n3,n4,n1",
      "w41 Thighway=residential Nn2,n5", "w42 Thighway=service Nn5,n6",
      "w43 Tbuilding=no,amenity=parking Nn2,n3", "w44 Tbuilding=yes Nn1,n2,n3,n4,n1",
      "w45 Thighway=path,amenity=parking Nn53,n54",
      "r99 Ttype=multipolygon,building=yes Mw999@outer",
    ])});
    const overlapping:AreaGeometry={type:"MultiPolygon",coordinates:[
      [[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]],
      [[[0.5,-1],[2,-1],[2,1],[0.5,1],[0.5,-1]]],
    ]};
    const contexts=[
      {context:overlapping,walking:overlapping},
      {context:overlapping,walking:structuredClone(overlapping)},
      {context:overlapping,walking:rectangle([-0.1,-0.1,0.1,0.1])},
      // Keep independent queries correct even when the walking envelope is outside the context.
      {context:overlapping,walking:rectangle([4,-0.1,5,0.1])},
      {context:rectangle([-0.001,-0.001,0.001,0.001]),walking:overlapping},
    ];
    for(const {context,walking} of contexts) {
      const expected={ways:[...store.ways(walking)],buildings:[...store.buildings(context)],evidence:[...store.evidence(context)]};
      const entries=[...store.context(context,walking)];
      expect({
        ways:entries.flatMap(entry=>entry.kind==="way" ? [{way:entry.way,nodes:entry.nodes}] : []),
        buildings:entries.flatMap(entry=>entry.kind==="building" ? [entry.centroid] : []),
        evidence:entries.flatMap(entry=>entry.kind==="evidence" ? [entry.evidence] : []),
      }).toEqual(expected);
    }
    const entries=[...store.context(overlapping)];
    const walking=entries.find(entry=>entry.kind==="way"&&entry.way.externalId==="way/40");
    expect(walking).toMatchObject({kind:"way",way:{bidirectional:false,accessState:"public",nodeIds:["osm-node-1","osm-node-4","osm-node-3","osm-node-2","osm-node-1"]}});
    expect(entries.filter(entry=>entry.kind==="evidence"&&entry.evidence.externalId==="way/40")).toEqual([
      "parking","trailhead","information","gate",
    ].map(kind=>({kind:"evidence",evidence:expect.objectContaining({kind,nodeIds:["osm-node-1","osm-node-2","osm-node-3","osm-node-4","osm-node-1"],coordinates:[[0,0],[1,0],[1,1],[0,1],[0,0]]})})));
    expect(entries.filter(entry=>entry.kind==="evidence"&&entry.evidence.externalId==="node/50")).toHaveLength(4);
    expect(entries.some(entry=>entry.kind==="evidence"&&entry.evidence.externalId==="node/51")).toBe(false);
    expect(entries.filter(entry=>entry.kind==="way"&&entry.way.externalId==="way/40")).toHaveLength(1);
    expect(store.db.prepare("SELECT disposition FROM inventory WHERE id='relation/99'").get()?.disposition).toBe("unsupported");
  });

  it("reads way geometry once and reduces nearby-way/tagged-node selections from three/two to one", async () => {
    const store=make();
    await store.import(async()=>{}, {lines:lines([...fixtures,"w40 Thighway=path,building=yes,amenity=parking,information=trailhead,barrier=gate,tourism=information Nn1,n2,n3,n4,n1"])});
    const queries=vi.spyOn(store.db,"prepare"),parses=vi.spyOn(JSON,"parse");
    const geometryReads=()=>parses.mock.calls.filter(([value])=>value==="[[0,0],[1,0],[1,1],[0,1],[0,0]]").length;
    Array.from(store.ways(area));Array.from(store.buildings(area));Array.from(store.evidence(area));
    const count=(prefix:string)=>queries.mock.calls.filter(([sql])=>sql.startsWith(prefix)).length;
    expect(count("SELECT w.*")).toBe(3);
    expect(count("SELECT p.* FROM nodes")).toBe(2);
    expect(geometryReads()).toBe(3);
    queries.mockClear();parses.mockClear();
    const entries:CoverageContextEntry[]=[...store.context(area)];
    expect(entries).not.toHaveLength(0);
    expect(count("SELECT w.*")).toBe(1);
    expect(count("SELECT p.* FROM nodes")).toBe(1);
    expect(count("SELECT p.* FROM relation_buildings")).toBe(1);
    expect(geometryReads()).toBe(1);
    queries.mockRestore();parses.mockRestore();
  });

  it("binds persisted stores and filenames to source, normalization version, and bounded geometry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "compact-source-")); directories.push(directory);
    const file = path.join(directory, "source.sqlite");
    const store = make(area, file);
    await store.import(async () => {}, { lines: lines() });
    expect(()=>new CoverageSourceStore(file, source, rectangle([0,0,1,1]))).toThrow("fingerprint mismatch");
    expect(sourceStoreFileName(source,area)).not.toBe(sourceStoreFileName(source,rectangle([0,0,1,1])));
    const identity = store.db.prepare("SELECT value FROM meta WHERE key='source'").get() as {value:string};
    store.db.prepare("UPDATE meta SET value=? WHERE key='source'").run(identity.value.replace(/^source-normalization-v\d+:/, "source-normalization-v6:"));
    expect(()=>new CoverageSourceStore(file, source, area)).toThrow("fingerprint mismatch");
    expect(sourceStoreFileName(source,area)).not.toContain("source-normalization-v6");
  });
});
