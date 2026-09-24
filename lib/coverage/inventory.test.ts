import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";
import { reconcileInventory } from "./inventory";

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
