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
    expect(() => reconcileInventory(raw, graph, coverage)).toThrow("Unexplained compiler loss");
    const way = [...raw.ways(coverage)][0]!.way;
    graph.putWay({ ...way, accessState: "closed" });
    const metrics = { lengthM: 100, gainM: 0, lossM: 0, maxElevationM: 100, maxSustainedGradePct: 0, elevationProfile: null };
    for (const edge of compiledEdgesForSegment(way, 0, way.coordinates.slice(0,2), metrics)) graph.putEdge(edge);
    const audit = reconcileInventory(raw, graph, coverage);
    expect(audit).toMatchObject({ coveredSegments: 1, frontierCount: 1 });
    expect(audit.frontierPreview[0]).toMatchObject({ node: "osm-node-2", way: "way/10" });
    expect(audit.dispositions).toContainEqual({ disposition: "restricted", reason: "access:closed", count: 1 });
  } finally { raw.close(); graph.close(); rmSync(directory, { recursive: true, force: true }); }
});
