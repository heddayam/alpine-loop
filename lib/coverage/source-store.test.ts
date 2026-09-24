import { afterEach, describe, expect, it } from "vitest";
import { CoverageSourceStore } from "./source-store";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { rectangle } from "./geometry";

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
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
const area = rectangle([-1, -1, 4, 2]);

describe("coverage source staging", () => {
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
