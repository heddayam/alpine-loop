import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoverageSourceStore, sourceStoreFileName } from "./source-store";
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

  it("binds persisted stores and filenames to source, normalization version, and bounded geometry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "compact-source-")); directories.push(directory);
    const file = path.join(directory, "source.sqlite");
    const store = make(area, file);
    await store.import(async () => {}, { lines: lines() });
    expect(()=>new CoverageSourceStore(file, source, rectangle([0,0,1,1]))).toThrow("fingerprint mismatch");
    expect(sourceStoreFileName(source,area)).not.toBe(sourceStoreFileName(source,rectangle([0,0,1,1])));
  });
});
