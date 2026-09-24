import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "@/lib/data/adapters";
import type { CoverageRunnerContext } from "@/lib/coverage-jobs/types";
import { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";
import { installedSnapshot, plan, run } from "./runtime";
import * as publisher from "@/lib/data/progressive/publish";
import { CoverageResourceGuard } from "./resources";

vi.mock("@/lib/data/osm/source", () => ({ readPinnedOsmSnapshot: vi.fn(), refreshPinnedOsmSnapshot: vi.fn() }));
vi.mock("./elevation", () => ({ elevationFor: vi.fn(), describeCanonicalElevation: vi.fn(), elevationCache: () => ({}), elevationPinsFingerprint: vi.fn(async () => "fixture-pins") }));
vi.mock("./collections", async (importOriginal) => ({
  ...await importOriginal<typeof import("./collections")>(), coverageExclusions: async () => [],
  legacyRegionIds: [], collections: async () => [],
  coverageSources: async () => [{ config: { id: "fixture", dataset: "Offline fixture", expectedByteLength: 100 }, geometry: { type: "Polygon", coordinates: [[[-122,47],[-121,47],[-121,49],[-122,49],[-122,47]]] } }],
}));
const source: SourceSnapshot = { id: "fixture", authority: "Alpine Loop", dataset: "Synthetic progressive loop", version: "1", retrievedAt: "2026-09-24T00:00:00Z", url: "https://example.invalid/progressive", license: "CC0-1.0", contentHash: `sha256:${"1".repeat(64)}`, localPath: path.resolve("data/fixtures/source/osm/progressive.opl") };
let root: string;
const importSource = CoverageSourceStore.prototype.import;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "coverage-runtime-"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", path.join(root, "stage"));
  vi.stubEnv("ALPINE_PACK_ROOT", path.join(root, "packs"));
  vi.stubEnv("ALPINE_ROUTE_JOBS_DB", path.join(root, "absent-route-jobs.sqlite"));
  const { readPinnedOsmSnapshot } = await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(source);
  const { elevationFor, describeCanonicalElevation, elevationPinsFingerprint } = await import("./elevation");
  vi.mocked(elevationPinsFingerprint).mockResolvedValue("fixture-pins");
  vi.mocked(elevationFor).mockResolvedValue({ source: { ...source, id: "dem" }, productFingerprint: "fixture-dem", sampler: { algorithmVersion: "fixture", sample: async (coordinates) => coordinates.map(() => 100) } } as Awaited<ReturnType<typeof elevationFor>>);
  vi.mocked(describeCanonicalElevation).mockImplementation(async geometry => elevationFor({id:"publication",geometry,status:"pending"},"","",true));
  const fixture = (await readFile(source.localPath, "utf8")).trim().split("\n");
  vi.spyOn(CoverageSourceStore.prototype, "import").mockImplementation(function (this: CoverageSourceStore, check) {
    async function* lines() { yield* fixture; }
    return importSource.call(this, check, { lines: lines() });
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const context = (): CoverageRunnerContext => ({ signal: new AbortController().signal, publishOnly: false, checkpoint: async () => "continue", report: async () => {} });
const request = (west: number, east: number) => plan({ collectionIds: [], geometry: rectangle([west,47.50,east,47.55]), memoryLimitMiB: 4096, offline: true });
async function edges(version: string) {
  const db = new DatabaseSync(path.join(root, "packs/local-coverage", version, "pack.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT id,from_node,to_node,length_m FROM edges ORDER BY id").all(); }
  finally { db.close(); }
}
it("expands separate requests into the same graph without losing their crossing segment", async () => {
  const first = await run(await request(-121.27,-121.25), context());
  const expanded = await run(await request(-121.25,-121.23), context());
  expect(expanded.snapshot!.unitIds.length).toBeGreaterThan(first.snapshot!.unitIds.length);
  expect(await edges(expanded.snapshot!.dataVersion)).toHaveLength(6);
  expect(await edges(first.snapshot!.dataVersion)).toHaveLength(2);
});

it("reuses verified segment metrics when expansion adds unrelated elevation pins", async () => {
  const { elevationFor, elevationPinsFingerprint } = await import("./elevation");
  const sample = vi.fn(async (coordinates: readonly unknown[]) => coordinates.map(() => 100));
  const initial = await elevationFor((await request(-121.27,-121.25)).units[0]!,"","",true);
  vi.mocked(elevationFor).mockResolvedValue({...initial,sampler:{algorithmVersion:"fixture",sample}});
  await run(await request(-121.27,-121.25),context());
  expect(sample).toHaveBeenCalled();
  sample.mockClear();
  vi.mocked(elevationPinsFingerprint).mockResolvedValue("expanded-pin-set");
  const expanded = await run(await request(-121.25,-121.23),context());
  expect(sample).not.toHaveBeenCalled();
  expect(await edges(expanded.snapshot!.dataVersion)).toHaveLength(6);
});
it("resumes a stopped metric transaction to the same final graph", async () => {
  const installation = await request(-121.27,-121.23);
  let preparing = false;
  await expect(run(installation, { ...context(), report: async ({ stage }) => { preparing = stage?.startsWith("Preparing") ?? false; },
    checkpoint: async () => preparing ? "pause" : "continue" })).rejects.toThrow("checkpoint");
  const resumed = await run(installation, context());
  expect(await edges(resumed.snapshot!.dataVersion)).toHaveLength(6);
  const again = await run(installation, context());
  expect(again.snapshot!.dataVersion).toBe(resumed.snapshot!.dataVersion);
});

it("keeps the old pointer while a changed source rebuild pauses, then publishes the full installed union", async () => {
  const first = await run(await request(-121.27,-121.25), context());
  const { readPinnedOsmSnapshot } = await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({ ...source, contentHash: `sha256:${"2".repeat(64)}` });
  const expanded = await request(-121.25,-121.23);
  let preparing = false;
  await expect(run(expanded, { ...context(), report: async ({ stage }) => { preparing = stage?.startsWith("Preparing") ?? false; },
    checkpoint: async () => preparing ? "pause" : "continue" })).rejects.toThrow("checkpoint");
  expect((await installedSnapshot())?.dataVersion).toBe(first.snapshot?.dataVersion);
  expect(await edges(first.snapshot!.dataVersion)).toHaveLength(2);
  const completed = await run(expanded, context());
  expect(completed.snapshot!.dataVersion).not.toBe(first.snapshot!.dataVersion);
  expect(await edges(completed.snapshot!.dataVersion)).toHaveLength(6);
});

it("rebuilds the installed union if the DEM choice for old coverage changes", async () => {
  const first = await run(await request(-121.27,-121.25), context());
  const { elevationFor } = await import("./elevation");
  vi.mocked(elevationFor).mockResolvedValue({ source: { ...source, id: "dem-new", contentHash: `sha256:${"3".repeat(64)}` },
    productFingerprint: "changed-dem", sampler: { algorithmVersion: "fixture", sample: async (coordinates) => coordinates.map(() => 110) } } as Awaited<ReturnType<typeof elevationFor>>);
  const expanded = await run(await request(-121.25,-121.23), context());
  expect(expanded.snapshot!.dataVersion).not.toBe(first.snapshot!.dataVersion);
  expect(await edges(expanded.snapshot!.dataVersion)).toHaveLength(6);
});

it("rebuilds old coverage when its resumable stage was removed", async () => {
  const first = await run(await request(-121.27,-121.25), context());
  const marker = JSON.parse(await readFile(path.join(root, "packs/local-coverage", first.snapshot!.dataVersion, "coverage-generation.json"), "utf8")) as {stageKey:string};
  await rm(path.join(root, "stage", `${marker.stageKey}.sqlite`));
  const expanded = await run(await request(-121.25,-121.23), context());
  expect(await edges(expanded.snapshot!.dataVersion)).toHaveLength(6);
});

it("publishes a growing DEM mosaic with exactly its final source receipt", async () => {
  const { elevationFor } = await import("./elevation");
  vi.mocked(elevationFor).mockImplementation(async (unit) => ({
    source: {...source,id:unit.id === "publication" ? "usgs-dem-final" : "usgs-dem-initial"},
    productFingerprint:"fixture-dem",sampler:{algorithmVersion:"fixture",sample:async coordinates=>coordinates.map(()=>100)},
  }));
  const result = await run(await request(-121.27,-121.23),context());
  expect(await edges(result.snapshot!.dataVersion)).toHaveLength(6);
  const manifest = JSON.parse(await readFile(path.join(root,"packs/local-coverage",result.snapshot!.dataVersion,"manifest.json"),"utf8")) as {sources:{id:string}[]};
  expect(manifest.sources.filter(item=>item.id.startsWith("usgs-dem-")).map(item=>item.id)).toEqual(["usgs-dem-final"]);
});

it("rejects corrupt completed receipts before changing the installed snapshot", async () => {
  const first = await run(await request(-121.27,-121.25), context());
  const marker = JSON.parse(await readFile(path.join(root,"packs/local-coverage",first.snapshot!.dataVersion,"coverage-generation.json"),"utf8")) as {stageKey:string};
  const db = new DatabaseSync(path.join(root,"stage",`${marker.stageKey}.sqlite`));
  db.exec("DELETE FROM unit_edges"); db.close();
  await expect(run(await request(-121.25,-121.23),context())).rejects.toThrow("failed verification");
  expect((await installedSnapshot())?.dataVersion).toBe(first.snapshot!.dataVersion);
});

it.each(["disk", "memory"])("preserves the active snapshot after %s exhaustion", async failure => {
  const first = await run(await request(-121.27,-121.25),context());
  if (failure === "disk") vi.spyOn(publisher,"publishProgressiveGraph").mockRejectedValueOnce(Object.assign(new Error("No space left on device"),{code:"ENOSPC"}));
  else vi.spyOn(CoverageResourceGuard.prototype,"checkpoint").mockRejectedValueOnce(new Error("Coverage resource target exceeded"));
  await expect(run(await request(-121.25,-121.23),context())).rejects.toThrow(failure === "disk" ? "No space" : "resource target");
  expect((await installedSnapshot())?.dataVersion).toBe(first.snapshot!.dataVersion);
});

it("produces equivalent graphs for opposite installation orders and overlapping requests", async () => {
  await run(await request(-121.27,-121.25),context());
  const first = await run(await request(-121.26,-121.23),context());
  const expected = await edges(first.snapshot!.dataVersion);
  // Start a separate installation against the same committed offline fixture.
  vi.stubEnv("ALPINE_COVERAGE_ROOT",path.join(root,"reverse-stage"));
  vi.stubEnv("ALPINE_PACK_ROOT",path.join(root,"reverse-packs"));
  await run(await request(-121.25,-121.23),context());
  const reverse = await run(await request(-121.27,-121.24),context());
  const db = new DatabaseSync(path.join(root,"reverse-packs/local-coverage",reverse.snapshot!.dataVersion,"pack.sqlite"),{readOnly:true});
  try { expect(db.prepare("SELECT id,from_node,to_node,length_m FROM edges ORDER BY id").all()).toEqual(expected); }
  finally { db.close(); }
});

it("publishes empty coverage without downloading elevation for water-only sections", async () => {
  const {elevationFor,describeCanonicalElevation} = await import("./elevation");
  vi.mocked(elevationFor).mockRejectedValue(new Error("No DEM exists here"));
  vi.mocked(describeCanonicalElevation).mockResolvedValue(null);
  const result = await run(await request(-121.9,-121.8),context());
  expect(result.status).toBe("completed");
  expect(await edges(result.snapshot!.dataVersion)).toHaveLength(0);
  expect(elevationFor).not.toHaveBeenCalled();
});

it("replays an unpublished preparation automatically after its DEM inputs change", async () => {
  const pending = await request(-121.27,-121.23);
  await expect(run(pending,{...context(),report:async ({stage})=>{if(stage?.startsWith("Prepared"))throw new Error("paused before publication");}})).rejects.toThrow("paused before publication");
  expect(await installedSnapshot()).toBeNull();
  const {elevationFor} = await import("./elevation");
  vi.mocked(elevationFor).mockResolvedValue({source:{...source,id:"new-dem"},productFingerprint:"replacement-tile",
    sampler:{algorithmVersion:"fixture",sample:async coordinates=>coordinates.map(()=>110)}});
  const result = await run(pending,context());
  expect(result.status).toBe("completed");
  expect(await edges(result.snapshot!.dataVersion)).toHaveLength(6);
});

it("recovers a paused expansion when only its new area's elevation input changes", async () => {
  const first = await run(await request(-121.27,-121.25),context());
  const expansion = await request(-121.25,-121.23);
  await expect(run(expansion,{...context(),report:async ({stage})=>{if(stage?.startsWith("Prepared"))throw new Error("pause expansion");}})).rejects.toThrow("pause expansion");
  const {elevationFor} = await import("./elevation");
  const original = await elevationFor(expansion.units[0]!,"","",true);
  vi.mocked(elevationFor).mockImplementation(async unit => unit.id === expansion.units[0]!.id
    ? {...original,source:{...original.source,id:"replacement-dem"},productFingerprint:"replacement-tile"} : original);
  let replayed = false;
  const result = await run(expansion,{...context(),report:async ({stage})=>{
    if (stage?.startsWith("Elevation inputs changed")) {
      replayed = true;
      expect((await installedSnapshot())?.dataVersion).toBe(first.snapshot!.dataVersion);
      expect(await edges(first.snapshot!.dataVersion)).toHaveLength(2);
    }
  }});
  expect(replayed).toBe(true);
  expect(result.status).toBe("completed");
  expect(await edges(result.snapshot!.dataVersion)).toHaveLength(6);
});

it("publishes West Cady, wholly omitted Pilchuck, and the formerly cut road approach from the broader inventory", async () => {
  const fixture = (await readFile("data/fixtures/source/osm/coverage-regressions.opl","utf8")).trim().split("\n");
  vi.mocked(CoverageSourceStore.prototype.import).mockImplementation(function (this:CoverageSourceStore,check) {
    async function* lines() {yield* fixture;}
    return importSource.call(this,check,{lines:lines()});
  });
  const result = await run(await plan({collectionIds:[],geometry:rectangle([-121.9,47.8,-121.1,48.2]),memoryLimitMiB:4096,offline:true}),context());
  const published = await edges(result.snapshot!.dataVersion);
  for (const id of [372537133,951045864,951045865,37583693,218617733])
    expect(published.some(row=>String(row.id).startsWith(`osm-way-${id}:`))).toBe(true);
},30_000);
