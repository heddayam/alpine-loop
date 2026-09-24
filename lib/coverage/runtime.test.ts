import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { areaBounds } from "@/lib/graph/geometry";
import type { SourceSnapshot } from "@/lib/data/adapters";
import type { CoverageRunnerContext } from "@/lib/coverage-jobs/types";
import { CoverageSourceStore } from "./source-store";
import { rectangle, subtractCoverage } from "./geometry";
import { installedSnapshot, plan, run } from "./runtime";
import * as publisher from "@/lib/data/progressive/publish";
import { CoverageResourceGuard } from "./resources";

const algorithms=vi.hoisted(()=>({metricVersion:undefined as string|undefined}));
vi.mock("@/lib/data/elevation/uv-rasterio-sampler",async importOriginal=>{
  const actual=await importOriginal<typeof import("@/lib/data/elevation/uv-rasterio-sampler")>();
  return {...actual,get PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION(){return algorithms.metricVersion??actual.PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION;}};
});
vi.mock("@/lib/data/osm/source", () => ({ readPinnedOsmSnapshot: vi.fn(), refreshPinnedOsmSnapshot: vi.fn() }));
vi.mock("./elevation", () => ({ elevationFor: vi.fn(), describeCanonicalElevation: vi.fn(), elevationCache: () => ({}), elevationPinsFingerprint: vi.fn(async () => "fixture-pins") }));
vi.mock("./collections", async (importOriginal) => ({
  ...await importOriginal<typeof import("./collections")>(), coverageExclusions: async () => [],
  legacyRegionIds: [], collections: vi.fn(async () => []),
  coverageSources: async () => [{ config: { id: "fixture", dataset: "Offline fixture", expectedByteLength: 100 }, geometry: { type: "Polygon", coordinates: [[[-122,47],[-121,47],[-121,49],[-122,49],[-122,47]]] } }],
}));
const source: SourceSnapshot = { id: "fixture", authority: "Alpine Loop", dataset: "Synthetic progressive loop", version: "1", retrievedAt: "2026-09-24T00:00:00Z", url: "https://example.invalid/progressive", license: "CC0-1.0", contentHash: `sha256:${"1".repeat(64)}`, localPath: path.resolve("data/fixtures/source/osm/progressive.opl") };
let root: string;
const importSource = CoverageSourceStore.prototype.import;
beforeEach(async () => {
  algorithms.metricVersion=undefined;
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

it("plans every selected collection and the drawing together without filling the space between them", async () => {
  const { collections } = await import("./collections");
  vi.mocked(collections).mockResolvedValueOnce([{ id: "fixture-area", name: "Fixture area", geometry: rectangle([-121.9,47.5,-121.8,47.6]), sourceIds: ["fixture"], limitations: [] }]);
  const combined = await plan({ collectionIds: ["fixture-area"], geometry: rectangle([-121.3,47.5,-121.2,47.6]), memoryLimitMiB: 4096, offline: true });
  expect(areaBounds(combined.geometry)).toEqual([-121.9,47.5,-121.2,47.6]);
  expect(combined.geometry.type).toBe("MultiPolygon");
  expect(combined.units).toHaveLength(3);
});

it("reuses verified segment metrics when expansion adds unrelated elevation pins", async () => {
  const { elevationFor, elevationPinsFingerprint } = await import("./elevation");
  const sample = vi.fn(async (coordinates: ReadonlyArray<readonly [number,number]>) => coordinates.map(() => 100));
  const initial = await elevationFor((await request(-121.27,-121.25)).units[0]!,"","",true);
  vi.mocked(elevationFor).mockResolvedValue({...initial,sampler:{algorithmVersion:"fixture",sample}});
  await run(await request(-121.27,-121.25),context());
  const oldSegmentInterior = ([lon,lat]: readonly [number,number]) => lon < -121.25001 && lon > -121.25999 && lat > 47.51001 && lat < 47.53999;
  expect(sample.mock.calls.flatMap(([coordinates]) => coordinates).some(oldSegmentInterior)).toBe(true);
  sample.mockClear();
  vi.mocked(elevationPinsFingerprint).mockResolvedValue("expanded-pin-set");
  const expanded = await run(await request(-121.25,-121.23),context());
  expect(sample).toHaveBeenCalled(); // Newly eligible outer segments now need metrics.
  expect(sample.mock.calls.flatMap(([coordinates]) => coordinates).some(oldSegmentInterior)).toBe(false);
  expect(await edges(expanded.snapshot!.dataVersion)).toHaveLength(6);
});

it("publishes a fresh immutable generation when only the metric algorithm changes",async()=>{
  algorithms.metricVersion="usgs-3dep-13as-rasterio-tile-owner+metrics-v4";
  const installation=await request(-121.27,-121.23);
  const before=await run(installation,context());
  const previousEdges=await edges(before.snapshot!.dataVersion);
  const manifestFor=async(version:string)=>JSON.parse(await readFile(path.join(root,"packs/local-coverage",version,"manifest.json"),"utf8"));
  expect((await manifestFor(before.snapshot!.dataVersion)).metricAlgorithmVersion).toContain("metrics-v4");
  algorithms.metricVersion=undefined;
  const after=await run(installation,context());
  expect(after.snapshot!.dataVersion).not.toBe(before.snapshot!.dataVersion);
  expect(after.snapshot!.sourceFingerprint).not.toBe(before.snapshot!.sourceFingerprint);
  expect((await manifestFor(after.snapshot!.dataVersion)).metricAlgorithmVersion).toContain("metrics-v5");
  expect(await edges(after.snapshot!.dataVersion)).toEqual(previousEdges);
});

it("does not request border-external DEM for source segments excluded by the supported outer boundary", async () => {
  const fixture = [
    "n1 T x-121.55 y48.99", "n2 T x-121.45 y48.995", "n3 T x-121.4 y49.0019851",
    "n4 T x-121.35 y49",
    "w101 Thighway=path,name=Border%20trail Nn1,n2,n3",
    "w102 Thighway=path,name=Exact%20border%20endpoint Nn2,n4",
  ];
  vi.mocked(CoverageSourceStore.prototype.import).mockImplementation(function (this:CoverageSourceStore,check) {
    async function* lines() { yield* fixture; }
    return importSource.call(this,check,{lines:lines()});
  });
  const { elevationFor, elevationPinsFingerprint } = await import("./elevation");
  const base = await elevationFor((await request(-121.6,-121.3)).units[0]!,"","",true);
  const sample = vi.fn(async (coordinates:ReadonlyArray<readonly[number,number]>) => {
    expect(coordinates.every(([,lat]) => lat <= 49)).toBe(true);
    return coordinates.map(() => 100);
  });
  vi.mocked(elevationFor).mockImplementation(async (unit) => {
    expect(areaBounds(unit.geometry)[3]).toBeLessThanOrEqual(49);
    return {...base,sampler:{algorithmVersion:"fixture",sample}};
  });
  const result = await run(await plan({collectionIds:[],geometry:rectangle([-121.6,48.98,-121.3,49]),memoryLimitMiB:4096,offline:true}),context());
  expect(sample).toHaveBeenCalled();
  expect(vi.mocked(elevationPinsFingerprint).mock.calls.every(([,geometry]) => areaBounds(geometry)[3] <= 49)).toBe(true);
  expect(sample.mock.calls.flatMap(([coordinates])=>coordinates).some(([,lat])=>lat===49)).toBe(true);
  expect(await edges(result.snapshot!.dataVersion)).toHaveLength(4);
  const inventory = JSON.parse(await readFile(path.join(root,"packs/local-coverage",result.snapshot!.dataVersion,"coverage-inventory.json"),"utf8")) as {crossingSegmentCount:number}[];
  expect(inventory[0]?.crossingSegmentCount).toBe(1);
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

it("publishes reconciled old coverage before finishing a large changed-source expansion", async () => {
  const first = await run(await request(-121.49,-121.23), context());
  expect(first.snapshot!.unitIds).toHaveLength(2);
  const { readPinnedOsmSnapshot } = await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({ ...source, contentHash: `sha256:${"2".repeat(64)}` });
  const expanded = await plan({ collectionIds: [], geometry: rectangle([-121.99,47.01,-121.01,47.99]), memoryLimitMiB: 4096, offline: true });
  let prepared = 0;
  await expect(run(expanded, { ...context(), report: async ({stage}) => {
    if (stage?.startsWith("Prepared") && ++prepared === 1) throw new Error("pause during old-area rebuild");
  } })).rejects.toThrow("pause during old-area rebuild");
  expect((await installedSnapshot())?.dataVersion).toBe(first.snapshot!.dataVersion);
  const publishOnly = await run(expanded, { ...context(), publishOnly: true });
  expect(publishOnly.status).toBe("paused");
  expect((await installedSnapshot())?.dataVersion).toBe(first.snapshot!.dataVersion);
  let rebuiltOldArea = false;
  await expect(run(expanded, { ...context(), report: async ({stage,snapshot}) => {
    if (stage === "Coverage published" && snapshot?.dataVersion !== first.snapshot!.dataVersion) {
      expect(subtractCoverage(first.snapshot!.geometry,snapshot!.geometry)).toBeNull();
      expect(snapshot!.unitIds.length).toBeLessThan(expanded.units.length);
      rebuiltOldArea = true;
    }
    if (rebuiltOldArea && stage?.startsWith("Preparing installation unit")) throw new Error("pause after old-area publication");
  } })).rejects.toThrow("pause after old-area publication");
  expect(rebuiltOldArea).toBe(true);
  const active = await installedSnapshot();
  expect(active?.dataVersion).not.toBe(first.snapshot!.dataVersion);
  expect(subtractCoverage(first.snapshot!.geometry,active!.geometry)).toBeNull();
  expect(active!.unitIds.length).toBeLessThan(expanded.units.length);
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


it.each(["roads", "buildings", "evidence"])("pauses during large %s context ingestion and resumes without a premature unit receipt", async kind => {
  const installation = await request(-121.27,-121.25);
  const first = await run(installation,context());
  const fixture = (await readFile(source.localPath,"utf8")).trim().split("\n");
  for (let i=0;i<1501;i++) {
    const id=1000+i, lon=-121.26+(kind==="buildings"?i%100*0.00002:i*0.000001);
    const lat=47.52+(kind==="buildings"?Math.floor(i/100)*0.00002:0);
    fixture.push(`n${id} T${kind==="buildings"?"building=yes":kind==="evidence"?"amenity=parking":""} x${lon} y${lat}`);
  }
  if (kind==="roads") for (let i=0;i<1500;i++) fixture.push(`w${1000+i} Thighway=residential Nn${1000+i},n${1001+i}`);
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,contentHash:`sha256:${"4".repeat(64)}`});
  vi.mocked(CoverageSourceStore.prototype.import).mockImplementation(function(this:CoverageSourceStore,check) {
    async function* lines(){yield* fixture;}
    return importSource.call(this,check,{lines:lines()});
  });
  const table=kind==="roads"?"ways":kind;
  const where=kind==="roads"?" WHERE external_id GLOB 'way/1[0-9][0-9][0-9]' OR external_id GLOB 'way/2[0-9][0-9][0-9]'":"";
  let preparing=false,interruptedRows=0,interruptedStage="";
  await expect(run(installation,{...context(),report:async({stage})=>{preparing=stage?.startsWith("Preparing installation unit")??false;},checkpoint:async()=>{
    if(!preparing)return "continue";
    for(const name of await readdir(path.join(root,"stage"))) {
      if(!name.endsWith(".sqlite")||name.startsWith("source-"))continue;
      const file=path.join(root,"stage",name),db=new DatabaseSync(file,{readOnly:true});
      try {
        const count=Number(db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get()!.n);
        if(!count)continue;
        expect(count).toBeLessThan(1500);
        expect(db.prepare("SELECT stage FROM receipts WHERE stage LIKE 'unit:%'").all()).toEqual([]);
        interruptedRows=count;interruptedStage=file;
        return "pause";
      } finally {db.close();}
    }
    return "continue";
  }})).rejects.toThrow("checkpoint");
  expect(interruptedRows).toBeGreaterThan(0);
  expect((await installedSnapshot())!.dataVersion).toBe(first.snapshot!.dataVersion);
  const resumed=await run(installation,context());
  const actual=await edges(resumed.snapshot!.dataVersion);
  const staged=new DatabaseSync(interruptedStage,{readOnly:true});
  try {
    expect(Number(staged.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get()!.n)).toBe(kind==="roads"?1500:1501);
    expect(staged.prepare("SELECT stage FROM receipts WHERE stage LIKE 'unit:%'").all()).toHaveLength(1);
  } finally {staged.close();}
  vi.stubEnv("ALPINE_COVERAGE_ROOT",path.join(root,"uninterrupted-stage"));
  vi.stubEnv("ALPINE_PACK_ROOT",path.join(root,"uninterrupted-packs"));
  const uninterrupted=await run(installation,context());
  const db=new DatabaseSync(path.join(root,"uninterrupted-packs/local-coverage",uninterrupted.snapshot!.dataVersion,"pack.sqlite"),{readOnly:true});
  try {expect(db.prepare("SELECT id,from_node,to_node,length_m FROM edges ORDER BY id").all()).toEqual(actual);}
  finally {db.close();}
});
