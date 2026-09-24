import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";
import { classifyIntendedInventory, reconcileInventory } from "./inventory";

it("blocks unexplained loss and records restricted trails and uninstalled connections separately", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "coverage-inventory-"));
  const source: SourceSnapshot = { id: "fixture", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24", url: "https://example.invalid", license: "CC0", localPath: "unused", contentHash: `sha256:${"1".repeat(64)}` };
  const raw = new CoverageSourceStore(":memory:", source);
  const graph = openProgressiveGraphStore({ stagingPath: path.join(directory, "graph.sqlite"), buildIdentity: "fixture" });
  try {
    async function* lines() { yield* ["n1 T x0 y0", "n2 T x1 y0", "n3 T x2 y0", "w10 Thighway=path,foot=yes Nn1,n2,n3"]; }
    await raw.import(async () => {}, { lines: lines() });
    const coverage = rectangle([-1,-1,1.5,1]);
    await expect(reconcileInventory(raw, graph, coverage)).rejects.toThrow("Unexplained compiler loss");
    const way = [...raw.ways(coverage)][0]!.way;
    graph.putWay({ ...way, accessState: "closed" });
    const metrics = { lengthM: 100, gainM: 0, lossM: 0, maxElevationM: 100, maxSustainedGradePct: 0, elevationProfile: null };
    for (const edge of compiledEdgesForSegment(way, 0, way.coordinates.slice(0,2), metrics)) graph.putEdge(edge);
    const audit = await reconcileInventory(raw, graph, coverage);
    expect(audit).toMatchObject({ coveredSegments: 1, frontierCount: 1, crossingSegmentCount: 1 });
    expect(audit.frontierPreview[0]).toMatchObject({ node: "osm-node-2", way: "way/10" });
    expect(audit.dispositions).toContainEqual({ disposition: "restricted", reason: "access:closed", count: 1 });
  } finally { raw.close(); graph.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("reports a source segment through coverage when both OSM nodes are outside, without inventing a frontier", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "coverage-crossings-"));
  const source: SourceSnapshot = { id: "fixture", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24", url: "https://example.invalid", license: "CC0", localPath: "unused", contentHash: `sha256:${"1".repeat(64)}` };
  const raw = new CoverageSourceStore(":memory:", source);
  const graph = openProgressiveGraphStore({ stagingPath: path.join(directory, "graph.sqlite"), buildIdentity: "fixture" });
  try {
    async function* lines() { yield* [
      "n1 T x-1 y0.5", "n2 T x2 y0.5", "n3 T x-1 y1", "n4 T x1 y-1",
      "w10 Thighway=path Nn1,n2", "w11 Thighway=path Nn3,n4",
    ]; }
    await raw.import(async () => {}, { lines: lines() });
    const coverage = rectangle([0,0,1,1]);
    const audit = await reconcileInventory(raw, graph, coverage);
    expect(audit).toMatchObject({ coveredSegments: 0, frontierCount: 0, crossingSegmentCount: 1 });
    expect(audit.crossingSegmentPreview).toEqual([{ way: "way/10", segment: 0, fromLon: -1, fromLat: 0.5, toLon: 2, toLat: 0.5 }]);
    expect((await reconcileInventory(raw, graph, coverage)).crossingSegmentCount).toBe(1);
  } finally { raw.close(); graph.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("interrupts within one long source way and replays the complete audit", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "coverage-inventory-pause-"));
  const source: SourceSnapshot = { id: "fixture", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24", url: "https://example.invalid", license: "CC0", localPath: "unused", contentHash: `sha256:${"1".repeat(64)}` };
  const raw = new CoverageSourceStore(":memory:", source);
  const graph = openProgressiveGraphStore({ stagingPath: path.join(directory, "graph.sqlite"), buildIdentity: "fixture" });
  try {
    async function* lines() {
      for (let i = 1; i <= 1501; i++) yield `n${i} T x${i % 2 ? -1 : 2} y0.5`;
      yield `w1 Thighway=path N${Array.from({length:1501}, (_, i) => `n${i+1}`).join(",")}`;
    }
    await raw.import(async () => {}, { lines: lines() });
    const coverage = rectangle([0,0,1,1]);
    let classificationChecks = 0;
    await expect(classifyIntendedInventory(raw, coverage, [], async () => {
      if (++classificationChecks === 2) throw new Error("pause classification");
    })).rejects.toThrow("pause classification");
    await classifyIntendedInventory(raw, coverage, []);
    expect(raw.db.prepare("SELECT disposition FROM inventory WHERE id='way/1'").get()!.disposition).toBe("pending");
    const expected = await reconcileInventory(raw, graph, coverage);
    let checks = 0;
    await expect(reconcileInventory(raw, graph, coverage, async () => {
      if (++checks === 2) throw new Error("pause");
    })).rejects.toThrow("pause");
    const partial = Number(raw.db.prepare("SELECT count(*) AS n FROM coverage_crossing_segments").get()!.n);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1000);
    expect(await reconcileInventory(raw, graph, coverage)).toEqual(expected);
    expect(expected.crossingSegmentCount).toBe(1500);
  } finally { raw.close(); graph.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("accounts for intended pending trails and policy exclusions separately from provider candidates", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "coverage-dispositions-"));
  const source: SourceSnapshot = { id: "fixture", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24", url: "https://example.invalid", license: "CC0", localPath: "unused", contentHash: `sha256:${"1".repeat(64)}` };
  const raw = new CoverageSourceStore(":memory:", source);
  const graph = openProgressiveGraphStore({ stagingPath: path.join(directory, "graph.sqlite"), buildIdentity: "fixture" });
  try {
    async function* lines() {
      // Installed; wholly omitted but intended; wholly excluded outside intended;
      // partly installed; partly excluded; provider-only; crossing without nodes inside.
      const segments = [[0.1,0.2],[1.1,1.2],[3.1,3.2],[0.3,0.4,1.4],[0.35,0.45,2.2],[4.1,4.2],[-1,1],[1.5,1.6]];
      let node = 0;
      for (let index=0;index<segments.length;index++) {
        const refs = [];
        for (const x of segments[index]!) { refs.push(`n${++node}`); yield `n${node} T x${x} y0.5`; }
        yield `w${index+1} Thighway=path${index === 7 ? ",access=private" : ""} N${refs.join(",")}`;
      }
    }
    await raw.import(async () => {}, { lines: lines() });
    const coverage = rectangle([0,0,0.5,1]);
    const intendedCoverage = rectangle([0,0,2,1]);
    const exclusions = [{id:"policy",geometry:rectangle([2,0,3.5,1])}];
    const metrics = { lengthM: 100, gainM: 0, lossM: 0, maxElevationM: 100, maxSustainedGradePct: 0, elevationProfile: null };
    for (const {way} of raw.ways(coverage,0)) if (["way/1","way/4","way/5"].includes(way.externalId)) {
      graph.putWay(way);
      for (const edge of compiledEdgesForSegment(way,0,way.coordinates.slice(0,2),metrics)) graph.putEdge(edge);
    }
    await classifyIntendedInventory(raw,intendedCoverage,exclusions);
    expect(raw.db.prepare("SELECT count(*) AS n FROM inventory WHERE disposition='installed'").get()!.n).toBe(0);
    const audit = await reconcileInventory(raw,graph,coverage);
    const dispositions = raw.db.prepare("SELECT id,disposition,reason FROM inventory ORDER BY id").all();
    expect(dispositions).toEqual([
      {id:"way/1",disposition:"installed",reason:"covered-source-segments-reconciled"},
      {id:"way/2",disposition:"pending",reason:"pending-installation"},
      {id:"way/3",disposition:"excluded",reason:"intentionally-excluded:policy"},
      {id:"way/4",disposition:"pending",reason:"covered-source-segments-reconciled"},
      {id:"way/5",disposition:"pending",reason:"partially-intentionally-excluded"},
      {id:"way/6",disposition:"candidate",reason:"access:unknown"},
      {id:"way/7",disposition:"pending",reason:"pending-installation"},
      {id:"way/8",disposition:"restricted",reason:"access:private"},
    ]);
    expect(audit).toMatchObject({coveredSegments:3,frontierCount:2,crossingSegmentCount:3});
    expect(await reconcileInventory(raw,graph,coverage)).toEqual(audit);
    // A changed policy must invalidate its earlier excluded disposition.
    await classifyIntendedInventory(raw,rectangle([0,0,3.5,1]),[]);
    expect(raw.db.prepare("SELECT disposition,reason FROM inventory WHERE id='way/3'").get()).toEqual({
      disposition:"pending",reason:"pending-installation",
    });
    expect(raw.db.prepare("SELECT disposition,reason FROM inventory WHERE id='way/5'").get()).toEqual({
      disposition:"pending",reason:"pending-installation",
    });
  } finally { raw.close(); graph.close(); rmSync(directory, {recursive:true,force:true}); }
});
