import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DataRelease } from "@/lib/contracts/releases";
import type { SourceSnapshot } from "@/lib/data/adapters";
import type { CoverageRunnerContext } from "./types";
import { filteredSourceLines } from "./source-filter";
import { rectangle } from "./geometry";
import { buildLocalCoverage } from "./runtime";
import { calculateEdgeMetricsBatch } from "@/lib/data/metrics";
import type { SourceRecipe } from "./recipe";

vi.mock("@/lib/data/metrics", async original => { const actual=await original<typeof import("@/lib/data/metrics")>(); return {...actual,calculateEdgeMetricsBatch:vi.fn(actual.calculateEdgeMetricsBatch)}; });
vi.mock("@/lib/data/progressive/topology", async original => { const actual=await original<typeof import("@/lib/data/progressive/topology")>();return {...actual,writeProgressiveTopology:vi.fn(actual.writeProgressiveTopology)}; });
const algorithms=vi.hoisted(()=>({metricVersion:undefined as string|undefined}));
vi.mock("@/lib/data/elevation/uv-rasterio-sampler",async importOriginal=>{
  const actual=await importOriginal<typeof import("@/lib/data/elevation/uv-rasterio-sampler")>();
  return {...actual,get PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION(){return algorithms.metricVersion??actual.PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION;}};
});
vi.mock("@/lib/data/osm/source", async (importOriginal) => ({...await importOriginal<typeof import("@/lib/data/osm/source")>(), readOsmSourceConfig: vi.fn(), inspectPinnedOsmSnapshot: vi.fn(), readPinnedOsmSnapshot: vi.fn(), refreshPinnedOsmSnapshot: vi.fn() }));
vi.mock("./elevation", () => ({ elevationFor: vi.fn(), describeCanonicalElevation: vi.fn(), elevationCache: () => ({}) }));
const source: SourceSnapshot = { id: "fixture", authority: "Alpine Loop", dataset: "Synthetic progressive loop", version: "1", retrievedAt: "2026-09-24T00:00:00Z", url: "https://example.invalid/progressive", license: "CC0-1.0", contentHash: `sha256:${"1".repeat(64)}`, localPath: path.resolve("data/fixtures/source/osm/progressive.opl") };
let root: string;
let fixtureLines: string[];
const secondNetwork=["n11 T x-121.12 y47.51","n12 T x-121.10 y47.51","n13 T x-121.11 y47.54","w201 Thighway=path,foot=yes,name=Second%20%loop Nn11,n12,n13,n11"];
vi.mock("./source-filter", () => ({ filteredSourceLines: vi.fn() }));
beforeEach(async () => {
  algorithms.metricVersion=undefined;
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "coverage-runtime-"));
  vi.stubEnv("ALPINE_RELEASE_ROOT", path.join(root,"release"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", path.join(root, "stage"));
  vi.stubEnv("ALPINE_PACK_ROOT", path.join(root, "packs"));
  vi.stubEnv("ALPINE_ROUTE_JOBS_DB", path.join(root, "absent-route-jobs.sqlite"));
  const { inspectPinnedOsmSnapshot, readPinnedOsmSnapshot } = await import("@/lib/data/osm/source");
  vi.mocked(inspectPinnedOsmSnapshot).mockResolvedValue(source);
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(source);
  const { elevationFor, describeCanonicalElevation } = await import("./elevation");
  vi.mocked(elevationFor).mockResolvedValue({ source: { ...source, id: "dem" }, productFingerprint: "fixture-dem", fingerprintForGeometry: () => "fixture-dem", sampler: { algorithmVersion: "fixture", sample: async (coordinates) => coordinates.map(() => 100) } } as Awaited<ReturnType<typeof elevationFor>>);
  vi.mocked(describeCanonicalElevation).mockResolvedValue({source:{...source,id:"dem"},productFingerprint:"fixture-dem"});
  fixtureLines = [...(await readFile(source.localPath,"utf8")).trim().split("\n"),...secondNetwork];
  vi.mocked(filteredSourceLines).mockImplementation(async function* () { yield* fixtureLines; });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const context = (): CoverageRunnerContext => ({ signal: new AbortController().signal, checkpoint: async () => "continue", report: async () => {} });
const recipe = (): SourceRecipe => ({schemaVersion:1,sources:[{config:{schemaVersion:1,id:source.id,authority:source.authority,dataset:source.dataset,version:source.version,upstreamTimestamp:source.retrievedAt,url:source.url,expectedByteLength:100,license:source.license,attribution:"Fixture"},geometry:rectangle([-123,46,-119,49]),sha256:source.contentHash}],exclusions:[],reviewedRegionIds:[],memoryLimitMiB:4096,offline:true,limitations:[]});
const startArea = rectangle([-121.27,47.50,-121.25,47.52]);
const secondArea = rectangle([-121.13,47.50,-121.09,47.54]);
const build = (area = startArea, ctx = context(), input = recipe()) => buildLocalCoverage(input, area, ctx);
async function release(): Promise<DataRelease> {return JSON.parse(await readFile(path.join(root,"release/release.json"),"utf8"));}
async function pieces() {
  const result=[];
  for(const artifact of (await release()).artifacts) {
    const raw=gunzipSync(await readFile(path.join(root,"release",artifact.path)));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(artifact.id);
    expect(raw.length).toBe(artifact.bytes);
    const file=path.join(root,"piece.sqlite");await writeFile(file,raw);
    const db=new DatabaseSync(file,{readOnly:true});
    try { result.push({
      edges:db.prepare("SELECT * FROM edges ORDER BY id").all(),nodes:db.prepare("SELECT * FROM nodes ORDER BY id").all(),
      access:db.prepare("SELECT * FROM access_points ORDER BY id").all(),
      metadata:db.prepare("SELECT * FROM metadata ORDER BY key").all(),
    });expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]); }
    finally {db.close();}
  }
  return result;
}
it("prepares all local components without statewide discovery, advertising only starts",async()=>{
  fixtureLines.push("n21 T x-119.5 y47.5","n22 T x-119.49 y47.5","w202 Thighway=path Nn21,n22");
  await build();
  const result=await release(), [piece]=await pieces();
  expect(result.partitioning).toBe("local-areas");
  expect(result.sections).toHaveLength(1);
  expect(result.sections[0]!.geometry).toEqual(startArea);
  expect(result.sections[0]!.area).toEqual({maximumRouteMiles:40,bufferMiles:25});
  expect(result.artifacts[0]!.startGeometry).toEqual(startArea);
  expect(piece!.edges).toHaveLength(12);
  expect(piece!.nodes.some(node=>node.lon===-121.24)).toBe(true);
  expect(piece!.edges.some(edge=>String(edge.id).startsWith("osm-way-202:"))).toBe(false);
  expect(piece!.access.length).toBeGreaterThan(0);
  expect(filteredSourceLines).toHaveBeenCalledOnce();
  await expectNoScratch();
});
async function expectNoScratch(){expect((await readdir(path.join(root,"stage"))).filter(file=>file.startsWith(".area-"))).toEqual([]);}

it("reuses immutable area bytes without elevation sampling or topology recomputation",async()=>{
  const {elevationFor}=await import("./elevation"), {writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  await build();const first=await release(),artifact=first.artifacts[0]!,modified=(await stat(path.join(root,"release",artifact.path))).mtimeMs;
  vi.mocked(elevationFor).mockClear();vi.mocked(writeProgressiveTopology).mockClear();vi.mocked(filteredSourceLines).mockClear();
  await build();
  expect(await release()).toEqual(first);
  expect((await stat(path.join(root,"release",artifact.path))).mtimeMs).toBe(modified);
  expect(elevationFor).not.toHaveBeenCalled();expect(writeProgressiveTopology).not.toHaveBeenCalled();expect(filteredSourceLines).not.toHaveBeenCalled();
});
it("adding an overlapping area reuses segment measurements and preserves prior bytes",async()=>{
  await build();const before=await release(),artifact=before.artifacts[0]!,bytes=await readFile(path.join(root,"release",artifact.path));
  vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build(secondArea);
  expect((await release()).sections).toHaveLength(2);
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(await readFile(path.join(root,"release",artifact.path))).toEqual(bytes);
});
it("cancellation leaves the prior catalog active and removes scratch",async()=>{
  await build();const prior=await readFile(path.join(root,"release/release.json"),"utf8");
  const paused=context();paused.report=async update=>{if(update.stage?.startsWith("Prepared "))throw new Error("paused after area");};
  await expect(build(secondArea,paused)).rejects.toThrow("paused after area");
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(prior);
  await expectNoScratch();
  const {elevationFor}=await import("./elevation"),{writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  vi.mocked(elevationFor).mockClear();vi.mocked(writeProgressiveTopology).mockClear();
  await build(secondArea);
  expect(elevationFor).not.toHaveBeenCalled();expect(writeProgressiveTopology).not.toHaveBeenCalled();
});
it("rejects corrupt artifact bytes and receipt identity before changing the catalog",async()=>{
  await build();const first=await release();
  const receiptFile=path.join(root,"stage/areas",(await readdir(path.join(root,"stage/areas")))[0]!);
  const original=await readFile(receiptFile,"utf8"),receipt=JSON.parse(original);
  receipt.release.id="forged-identity";await writeFile(receiptFile,JSON.stringify(receipt));
  await expect(build()).rejects.toThrow("checkpoint identity");
  await writeFile(receiptFile,original);
  await writeFile(path.join(root,"release",first.artifacts[0]!.path),"corrupt");
  await expect(build()).rejects.toThrow("checkpoint failed");
  expect(await release()).toEqual(first);await expectNoScratch();
});
it("invalidates artifact and metric caches when their algorithm changes",async()=>{
  await build();const before=await release();algorithms.metricVersion="changed-metrics-v2";
  vi.mocked(calculateEdgeMetricsBatch).mockClear();await build();
  expect((await release()).artifacts[0]!.graphId).not.toBe(before.artifacts[0]!.graphId);
  expect(calculateEdgeMetricsBatch).toHaveBeenCalled();
});
it("rejects source gaps before importing or sampling",async()=>{
  const input=recipe();input.sources[0]!.geometry=startArea;
  await expect(build(startArea,context(),input)).rejects.toThrow("complete 25-mile route buffer");
  expect(filteredSourceLines).not.toHaveBeenCalled();expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
});
it("keeps complete way context while publishing only segments inside the route buffer",async()=>{
  fixtureLines=["n1 T x-121.26 y47.51","n2 T x-121.24 y47.51","n3 T x-119.9 y47.52","w101 Thighway=path,foot=yes Nn1,n2,n3"];
  await build();expect((await pieces())[0]!.edges).toHaveLength(2);
});
it("applies access restrictions before compiling eligible local segments",async()=>{
  const named=await import("./named-areas");
  vi.spyOn(named,"preparedNamedAreas").mockImplementation(async input=>({sources:input.sources,namedAreas:[],searchRegions:[]}));
  const access=await import("@/lib/data/curated-access");
  vi.spyOn(access,"readCuratedAccessFile").mockResolvedValue({snapshot:{...source,id:"review"},restrictions:[{externalId:"way/201",accessState:"closed",reason:"reviewed closure",review:{reviewedAt:source.retrievedAt,reviewer:"fixture"}}]});
  await build(startArea,context(),{...recipe(),reviewedRegionIds:["missing-fixture-region"]});
  const edges=(await pieces())[0]!.edges;
  expect(edges).toHaveLength(6);expect(edges.some(edge=>String(edge.id).startsWith("osm-way-201:"))).toBe(false);
});
it("does not silently combine different source pins across prepared areas",async()=>{
  await build();const before=await release();
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,contentHash:`sha256:${"2".repeat(64)}`});
  const input=recipe();input.sources[0]!.sha256=`sha256:${"2".repeat(64)}`;
  await expect(build(secondArea,context(),input)).rejects.toThrow("Conflicting source metadata");
  expect(await release()).toEqual(before);
});
it("retains unsupported building disclosures when reusing an area",async()=>{
  fixtureLines.push("r30 Ttype=multipolygon,building=yes Mw999@outer");
  await build();const before=await release();
  expect(before.limitations.some(message=>message.includes("1 unsupported building relations"))).toBe(true);
  await build();expect((await release()).limitations).toEqual(before.limitations);
});
it("rejects a mismatched source digest before local extraction",async()=>{
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,contentHash:`sha256:${"2".repeat(64)}`});
  await expect(build()).rejects.toThrow("Pinned source hash differs");expect(filteredSourceLines).not.toHaveBeenCalled();
});

it("keeps complete way segments crossing adjoining verified source extents",async()=>{
  const input=recipe(), first=input.sources[0]!;
  input.sources=[{...first,geometry:rectangle([-123,46,-121.25,49])},{...first,config:{...first.config,id:"fixture-east"},geometry:rectangle([-121.25,46,-119,49])}];
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockImplementation(async (_root,config)=>({...source,id:config.id}));
  await build(startArea,context(),input);
  expect((await pieces())[0]!.edges).toHaveLength(12);
});

it("does not acquire elevation or publish when the local buffer has no eligible links",async()=>{
  fixtureLines=[];
  await expect(build()).rejects.toThrow("No eligible walking links");
  const {elevationFor,describeCanonicalElevation}=await import("./elevation");
  expect(elevationFor).not.toHaveBeenCalled();expect(describeCanonicalElevation).not.toHaveBeenCalled();
  await expectNoScratch();
});
