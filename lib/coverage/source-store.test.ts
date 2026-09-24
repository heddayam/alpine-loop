import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CoverageSourceStore } from "./source-store";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { rectangle, unionCoverage } from "./geometry";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const source: SourceSnapshot = { id: "fixture", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24", url: "https://example.invalid/fixture", license: "fixture", contentHash: `sha256:${"1".repeat(64)}`, localPath: "/offline-fixture.osm.pbf" };
const fixtures = [
  "n1 T x0 y0", "n2 T x1 y0", "n3 T x1 y1", "n4 T x0 y1",
  "n5 Thighway=trailhead,name=Trailhead x2 y0", "n6 T x3 y0",
  "w10 Thighway=path,foot=private Nn1,n2",
  "w11 Thighway=footway Nn2,n5", "w12 Thighway=footway Nn5,n6",
  "w13 Thighway=footway,footway=sidewalk Nn2,n3",
  "w20 T Nn1,n2,n3", "w21 T Nn1,n4,n3",
  "r30 Ttype=multipolygon,building=yes Mw20@outer,w21@outer",
  "r31 Ttype=multipolygon,name=Forest,boundary=protected_area Mw20@outer,w21@outer",
];
async function* lines(input = fixtures) { yield* input; }
const stores: CoverageSourceStore[] = [];
const make = () => { const store = new CoverageSourceStore(":memory:", source); stores.push(store); return store; };
const directories: string[] = [];
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const area = rectangle([-1, -1, 4, 2]);

describe("coverage source staging", () => {
  it("uses exact source bounds after spatial lookup, including boundary contacts and context", async () => {
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
    const plan=store.db.prepare(`EXPLAIN QUERY PLAN SELECT w.id FROM ways_spatial s CROSS JOIN ways w ON w.rowid=s.id
      WHERE s.minx<=? AND s.maxx>=? AND s.miny<=? AND s.maxy>=? ORDER BY w.id`).all(-121,-122,49,47);
    expect(plan[0]?.detail).toContain("VIRTUAL TABLE INDEX");
    expect(plan[1]?.detail).toContain("INTEGER PRIMARY KEY");
  });

  it("queries disconnected component envelopes without gap-only source context or duplicate rows",async()=>{
    const store=make();
    await store.import(async()=>{}, {lines:lines([
      "n1 Thighway=trailhead x0 y0", "n2 T x0.1 y0", "n3 T x10 y0", "n4 T x10.1 y0",
      "n5 T x5 y0", "n6 T x5.1 y0", "n7 T x-0.009 y0", "n8 T x-0.002 y0",
      "n9 Tbuilding=yes x5 y0.05", "n10 Thighway=trailhead x5 y0.06",
      "n11 T x5.1 y0.1", "n12 T x5 y0.1", "n13 T x0.1 y0.1", "n14 T x0 y0.1",
      "w10 Thighway=path Nn1,n2", "w20 Thighway=path Nn3,n4", "w30 Thighway=path Nn5,n6",
      "w40 Thighway=path Nn2,n3", "w50 Thighway=path Nn7,n8",
      "w60 Tamenity=parking Nn5,n6", "w61 Tbuilding=yes Nn5,n6,n11,n12,n5",
      "w62 Tbuilding=yes Nn1,n2,n13,n14,n1", "w63 Tamenity=parking Nn1,n2",
      "r70 Ttype=multipolygon,building=yes Mw61@outer",
    ])});
    const coverage=unionCoverage([rectangle([0,-0.1,0.1,0.1]),rectangle([10,-0.1,10.1,0.1])]);
    const ids=(context:number)=>[...store.ways(coverage,context)].map(({way})=>way.externalId);
    expect(ids(0)).toEqual(["way/10","way/20","way/40"]);
    expect(ids(0.01)).toEqual(["way/10","way/20","way/40","way/50"]);
    expect([...store.evidence(coverage)].map(item=>item.externalId)).toEqual(["node/1","way/63"]);
    expect([...store.buildings(coverage)].every(([lon])=>lon<1)).toBe(true);
    expect([...store.buildings(coverage)]).toHaveLength(1);
    expect(store.db.prepare("SELECT disposition FROM inventory WHERE id='way/30'").get()?.disposition).toBe("candidate");
    // Context envelopes overlap even though the two drawn polygons do not.
    const overlapping=unionCoverage([rectangle([-0.002,-0.001,0.002,0.001]),rectangle([0.008,-0.001,0.012,0.001])]);
    const expected=[...store.ways(overlapping)].map(({way})=>way.externalId);
    expect(expected).toEqual(["way/10","way/50"]);
    const iterator=store.ways(coverage),first=iterator.next().value!.way.externalId;
    expect([...store.ways(overlapping)].map(({way})=>way.externalId)).toEqual(expected);
    expect([first,...[...iterator].map(({way})=>way.externalId)]).toEqual(ids(0.01));
    expect([...store.evidence(overlapping)].map(item=>item.externalId)).toEqual(["node/1","way/63"]);
  });

  it("rebuilds interrupted and damaged derived spatial state without changing sealed source results", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([...fixtures,
      "w40 Tbuilding=yes Nn1,n2,n3,n4,n1", "w41 Tamenity=parking Nn1,n2,n3,n4,n1",
    ]) });
    const results=()=>({ways:[...store.ways(area)],buildings:[...store.buildings(area)],evidence:[...store.evidence(area)]});
    const before=results(), seal=store.receipt("normalized-seal-v1");
    store.db.exec("DROP TABLE temp.ways_spatial");
    await expect(store.import(async()=>{
      if (store.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='ways_spatial'").get() &&
        Number(store.db.prepare("SELECT count(*) AS n FROM ways_spatial").get()?.n)>0) throw new Error("spatial initialization paused");
    })).rejects.toThrow("spatial initialization paused");
    expect(()=>[...store.ways(area)]).toThrow("completed verified import");
    await store.import(async()=>{});
    expect(results()).toEqual(before);
    expect(store.receipt("normalized-seal-v1")).toBe(seal);
    store.db.exec("DELETE FROM ways_spatial WHERE id=(SELECT min(id) FROM ways_spatial)");
    await store.import(async()=>{});
    expect(results()).toEqual(before);
  });

  it("interrupts a file-backed integrity child and resumes the source seal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coverage-quick-check-"));
    directories.push(directory);
    const store = new CoverageSourceStore(path.join(directory, "source.sqlite"), source);
    stores.push(store);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; });
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ChildProcess);
    let checking = false, checks = 0;
    await expect(store.import(async () => {
      if (checking && ++checks === 2) throw new Error("pause integrity check");
    }, { lines: lines(), onStage: async (stage) => { if (stage === "integrity-check") checking = true; } })).rejects.toThrow("pause integrity check");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(store.db.isTransaction).toBe(false);
    expect(store.receipt("import-v2")).toBeUndefined();
    await store.import(async () => {}, { lines: lines() });
    expect(store.receipt("import-v2")).toBe("complete");
  });

  it("resumes committed rows without rewriting them and preserves contextual trail/access rules", async () => {
    const store = make();
    await expect(store.import(async () => { throw new Error("paused"); }, { lines: lines(), batchSize: 4 })).rejects.toThrow("paused");
    expect(store.receipt("import-lines-v2")).toBe("4");
    expect(store.receipt("normalized-seal-v1")).toBeUndefined();
    store.db.exec("CREATE TRIGGER no_replay BEFORE INSERT ON nodes WHEN NEW.id='1' BEGIN SELECT RAISE(ABORT,'replayed committed node'); END");
    await store.import(async () => {}, { lines: lines(), batchSize: 4 });
    const ways = [...store.ways(area)].map(({ way }) => way);
    expect(ways.find((way) => way.externalId === "way/10")?.accessState).toBe("private");
    expect(ways.filter((way) => way.edgeClass === "trail").map((way) => way.externalId)).toEqual(["way/10", "way/11", "way/12"]);
    expect(ways.find((way) => way.externalId === "way/13")?.edgeClass).toBe("sidewalk");
    expect([...store.evidence(area)].map((item) => item.externalId)).toEqual(["node/5"]);
    expect(store.db.prepare("SELECT disposition,reason FROM inventory WHERE id='way/12'").get()).toEqual({ disposition: "candidate", reason: "connected-trail-footway" });
    expect(store.db.prepare("SELECT reason FROM inventory WHERE id='relation/31'").get()).toEqual({ reason: "named-area-geometry-not-imported" });
  });

  it("does not reopen the source after a pause between raw import and normalization", async () => {
    const store = make();
    await expect(store.import(async () => { throw new Error("paused"); }, { lines: lines() })).rejects.toThrow("paused");
    expect(store.receipt("raw-import-v2")).toBe("complete");
    async function* forbidden(): AsyncGenerator<string> { throw new Error("raw import replayed"); }
    await store.import(async () => {}, { lines: forbidden() });
    expect(store.receipt("import-v2")).toBe("complete");
  });

  it("promotes branched footway chains but leaves disconnected footways and explicit sidewalks alone", async () => {
    const store=make();
    const network=[
      ...Array.from({length:9},(_,index)=>`n${index+1} T x${index} y0`),
      "w10 Thighway=path Nn1,n2", "w11 Thighway=footway Nn2,n3",
      "w12 Thighway=footway Nn3,n4", "w13 Thighway=footway Nn3,n5",
      "w14 Thighway=footway Nn8,n9", "w15 Thighway=footway,footway=sidewalk Nn2,n6",
    ];
    await store.import(async()=>{}, {lines:lines(network)});
    expect(store.db.prepare("SELECT id FROM ways WHERE kind='ambiguous' AND promoted=1 ORDER BY id").all().map((row)=>row.id)).toEqual(["11","12","13"]);
    expect(store.db.prepare("SELECT promoted FROM ways WHERE id='14'").get()?.promoted).toBe(0);
    expect(store.db.prepare("SELECT promoted FROM ways WHERE id='15'").get()?.promoted).toBe(0);
  });

  it("resumes promotion from persisted ways after a frontier checkpoint interruption", async () => {
    const store=make();
    const network=[
      ...Array.from({length:7},(_,index)=>`n${index+1} T x${index} y0`),
      "w10 Thighway=path Nn1,n2", "w11 Thighway=footway Nn2,n3",
      "w12 Thighway=footway Nn3,n4", "w13 Thighway=footway Nn4,n5",
      "w14 Thighway=footway Nn6,n7",
    ];
    let promoting=false;
    await expect(store.import(async()=>{
      if (promoting && Number(store.db.prepare("SELECT count(*) AS n FROM ways WHERE kind='ambiguous' AND promoted=1").get()?.n)>0)
        throw new Error("promotion paused");
    }, {lines:lines(network),onStage:async(stage)=>{if(stage==="context-promotion") promoting=true;}})).rejects.toThrow("promotion paused");
    expect(store.receipt("raw-import-v2")).toBe("complete");
    expect(store.receipt("import-v2")).toBeUndefined();
    await store.import(async()=>{}, {lines:lines(network)});
    expect(store.db.prepare("SELECT id FROM ways WHERE kind='ambiguous' AND promoted=1 ORDER BY id").all().map((row)=>row.id)).toEqual(["11","12","13"]);
    expect(store.receipt("import-v2")).toBe("complete");
  });

  it("rolls back uncommitted rows and resumes cleanly after a source stream error", async () => {
    const store = make();
    async function* failed() { yield* fixtures.slice(0, 6); throw new Error("stream failure"); }
    await expect(store.import(async () => {}, { lines: failed(), batchSize: 4 })).rejects.toThrow("stream failure");
    expect(store.db.prepare("SELECT count(*) AS count FROM nodes").get()?.count).toBe(4);
    expect(store.receipt("raw-import-v2")).toBeUndefined();
    await store.import(async () => {}, { lines: lines(), batchSize: 4 });
    expect(store.db.prepare("SELECT count(*) AS count FROM nodes").get()?.count).toBe(6);
  });

  it("rejects a changed raw line counter before skipping committed input", async () => {
    const store = make();
    await expect(store.import(async () => { throw new Error("paused"); }, { lines: lines(), batchSize: 4 })).rejects.toThrow("paused");
    store.mark("import-lines-v2", "5");
    async function* forbidden(): AsyncGenerator<string> { throw new Error("source stream was opened"); }
    await expect(store.import(async () => {}, { lines: forbidden() })).rejects.toThrow("raw batch counter or row range failed verification");
  });

  it("rejects a deleted or modified committed raw node before replay", async () => {
    const store = make();
    await expect(store.import(async () => { throw new Error("paused"); }, { lines: lines(), batchSize: 4 })).rejects.toThrow("paused");
    store.db.prepare("UPDATE nodes SET lon=99 WHERE id='1'").run();
    await expect(store.import(async () => {}, { lines: lines() })).rejects.toThrow("raw batch records failed checksum verification");
    store.db.prepare("UPDATE nodes SET lon=0 WHERE id='1'").run();
    store.db.prepare("DELETE FROM nodes WHERE id='1'").run();
    await expect(store.import(async () => {}, { lines: lines() })).rejects.toThrow("raw batch records failed checksum verification");
  });

  it("baselines an old committed prefix without changing its line checkpoint", async () => {
    const store = make();
    await expect(store.import(async () => { throw new Error("paused"); }, { lines: lines(), batchSize: 4 })).rejects.toThrow("paused");
    store.db.prepare("DELETE FROM receipts WHERE key LIKE 'raw-batch-v1:%'").run();
    await store.import(async () => {}, { lines: lines(), batchSize: 4 });
    expect(store.receipt("import-lines-v2")).toBe(String(fixtures.length));
    expect(JSON.parse(store.receipt("raw-batch-v1:4")!)?.legacyBaseline).toBe(true);
    expect(store.receipt(`raw-batch-v1:${fixtures.length}`)).toBeDefined();
  });

  it("leaves a legacy raw prefix uncertified when verification is interrupted, then resumes", async () => {
    const store = make();
    await expect(store.import(async () => { throw new Error("paused"); }, { lines: lines(), batchSize: 4 })).rejects.toThrow("paused");
    store.db.prepare("DELETE FROM receipts WHERE key LIKE 'raw-batch-v1:%'").run();
    await expect(store.import(async () => { throw new Error("verification paused"); }, { lines: lines(), batchSize: 4 })).rejects.toThrow("verification paused");
    expect(store.receipt("raw-batch-v1:4")).toBeUndefined();
    expect(store.receipt("import-lines-v2")).toBe("4");
    await store.import(async () => {}, { lines: lines(), batchSize: 4 });
    expect(JSON.parse(store.receipt("raw-batch-v1:4")!)?.legacyBaseline).toBe(true);
    expect(store.receipt("import-v2")).toBe("complete");
  });

  it("counts a relation-only building assembled from reversed outer way fragments", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    expect([...store.buildings(area)]).toEqual([[0.4, 0.4]]);
    expect([...store.buildings(rectangle([2, 2, 3, 3]))]).toEqual([]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='nodes_location'").get()?.name).toBe("nodes_location");
  });

  it("records malformed source building geometry as unsupported without silently dropping it", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([...fixtures.slice(0, 6), "r30 Ttype=multipolygon,building=yes Mw999@outer", "r31 Ttype=multipolygon,building=yes M"]) });
    expect(store.db.prepare("SELECT disposition,reason FROM inventory WHERE id='relation/30'").get()).toEqual({disposition:"unsupported",reason:"building-geometry:Building relation/30 references missing way/999"});
    expect(store.db.prepare("SELECT disposition FROM inventory WHERE id='relation/31'").get()?.disposition).toBe("unsupported");
    expect(store.receipt("import-v2")).toBe("complete");
  });

  it("counts buildings mapped as nodes using the existing centroid rounding", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines(["n1 Tbuilding=hut x0.123456 y0.654321"]) });
    expect([...store.buildings(area)]).toEqual([[0.12346, 0.65432]]);
  });

  it("rejects tampered normalized ways before a completed cached import is used", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    const seal = JSON.parse(store.receipt("normalized-seal-v1")!) as {sourceHash:string;algorithmVersion:string;counts:{ways:number}};
    expect(seal.sourceHash).toBe(source.contentHash);
    expect(seal.algorithmVersion).toBe("source-normalization-v2");
    expect(seal.counts.ways).toBeGreaterThan(0);
    store.db.prepare("UPDATE ways SET coordinates=? WHERE id='10'").run("[[99,99],[100,100]]");
    async function* forbidden(): AsyncGenerator<string> { throw new Error("raw import replayed"); }
    await expect(store.import(async () => {}, { lines: forbidden() })).rejects.toThrow("normalized records failed seal verification");
  });

  it("seals a legacy completed cache once and excludes mutable metrics and inventory", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    store.db.prepare("DELETE FROM receipts WHERE key='normalized-seal-v1'").run();
    await store.import(async () => {});
    expect(store.receipt("normalized-seal-v1")).toBeDefined();
    store.db.prepare("INSERT INTO metrics VALUES('10:0','new-algorithm','{}')").run();
    store.db.prepare("UPDATE inventory SET disposition='covered' WHERE id='way/10'").run();
    await expect(store.import(async () => {})).resolves.toBeUndefined();
  });

  it("does not certify an interrupted completed-cache verification", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines() });
    store.db.prepare("DELETE FROM receipts WHERE key IN ('normalized-seal-v1','unsupported-inventory-seal-v1')").run();
    let checks = 0;
    await expect(store.import(async () => { if (++checks === 3) throw new Error("verification paused"); })).rejects.toThrow("verification paused");
    expect(store.receipt("normalized-seal-v1")).toBeUndefined();
    expect(store.receipt("unsupported-inventory-seal-v1")).toBeUndefined();
    await store.import(async () => {});
    expect(store.receipt("normalized-seal-v1")).toBeDefined();
    expect(store.receipt("unsupported-inventory-seal-v1")).toBeDefined();
  });

  it("detects changes to immutable unsupported source-context inventory", async () => {
    const store = make();
    await store.import(async () => {}, { lines: lines([...fixtures.slice(0, 6), "r30 Ttype=multipolygon,building=yes Mw999@outer"]) });
    store.db.prepare("UPDATE inventory SET reason='silently lost' WHERE id='relation/30'").run();
    await expect(store.import(async () => {})).rejects.toThrow("unsupported inventory failed seal verification");
  });
});
