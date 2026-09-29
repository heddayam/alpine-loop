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
import type { CoverageRegion, CoverageRunnerContext } from "./types";
import { filteredSourceLines } from "./source-filter";
import { rectangle, subtractCoverage, unionCoverage } from "./geometry";
import { buildCoverageRegion } from "./runtime";
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
const consolidatedArea = rectangle([-121.28,47.49,-121.08,47.55]);
const region = (id:string, geometry=startArea): CoverageRegion => ({id,name:id,geometry,recipe:recipe(),sources:
  ["boundary","approaches"].map(kind=>({id:`region-${kind}-${id}`,authority:source.authority,dataset:kind,
    version:source.version,retrievedAt:source.retrievedAt,url:source.url,license:source.license,contentHash:source.contentHash}))});
const build = (area = startArea, ctx = context(), input = recipe()) => buildCoverageRegion({id:area===startArea?"first-region":"second-region",name:area===startArea?"First region":"Second region",geometry:area,recipe:input},ctx);
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
    });expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA freelist_count").get()!.freelist_count).toBe(0); }
    finally {db.close();}
  }
  return result;
}
it("prepares distance-relevant trails and advertises the named start footprint",async()=>{
  fixtureLines.push("n21 T x-119.5 y47.5","n22 T x-119.49 y47.5","w202 Thighway=path Nn21,n22");
  await build();
  const result=await release(), [piece]=await pieces();
  expect(result.partitioning).toBe("local-areas");
  expect(result.sections).toHaveLength(1);
  expect(result.sections[0]!.geometry).toEqual(startArea);
  expect(result.sections[0]!.area).toEqual({maximumRouteMiles:40,bufferMiles:25});
  expect(result.sections[0]!.name).toBe("First region");
  expect(result.regions).toEqual([expect.objectContaining({id:"first-region",name:"First region",geometry:startArea})]);
  expect(result.artifacts[0]!.startGeometry).toEqual(startArea);
  expect(piece!.edges.length).toBeGreaterThan(0);
  expect(piece!.edges.flatMap(edge=>JSON.parse(String(edge.geometry))).some(point=>point[0]===-121.1)).toBe(false);
  expect(piece!.edges.flatMap(edge=>JSON.parse(String(edge.geometry))).some(point=>point[0]===-121.24)).toBe(true);
  expect(piece!.edges.some(edge=>String(edge.id).startsWith("osm-way-202:"))).toBe(false);
  expect(piece!.access.length).toBeGreaterThan(0);
  expect(filteredSourceLines).toHaveBeenCalledOnce();
  await expectNoScratch();
});
async function expectNoScratch(){expect((await readdir(path.join(root,"stage"))).filter(file=>file.startsWith(".region-"))).toEqual([]);}

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
  const overlapping=rectangle([-121.26,47.50,-121.23,47.55]);
  await build(overlapping);
  expect((await release()).sections).toHaveLength(2);
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(await readFile(path.join(root,"release",artifact.path))).toEqual(bytes);
});
it("replaces one area's reviewed provenance without changing its installed neighbor",async()=>{
  const {localPath,...metadata}=source; void localPath;
  const first=(changed=false)=>({id:"first-region",name:"First region",geometry:startArea,recipe:recipe(),sources:
    ["boundary","approaches"].map(kind=>({...metadata,id:`region-${kind}-first-region`,
      contentHash:`sha256:${(changed?"2":"1").repeat(64)}`,retrievedAt:changed?"2026-09-25T00:00:00Z":metadata.retrievedAt}))});
  await buildCoverageRegion(first(),context()); await build(secondArea);
  const before=await release(),neighbor=before.artifacts.find(artifact=>artifact.regionId==="second-region")!;
  const unchanged=await readFile(path.join(root,"release",neighbor.path));
  await buildCoverageRegion(first(true),context());
  const after=await release();
  expect(after.sections).toHaveLength(2);
  expect(after.regions.map(region=>region.id)).toEqual(["first-region","second-region"]);
  expect(after.sources.filter(source=>source.id.startsWith("region-")).map(source=>source.contentHash)).toEqual([`sha256:${"2".repeat(64)}`,`sha256:${"2".repeat(64)}`]);
  expect(after.artifacts.find(artifact=>artifact.regionId==="second-region")).toEqual(neighbor);
  expect(await readFile(path.join(root,"release",neighbor.path))).toEqual(unchanged);
});
it("retires two covered areas atomically while retaining a neighbor, provider pins, and every old blob",async()=>{
  await buildCoverageRegion(region("pilot-one"),context());
  await buildCoverageRegion(region("pilot-two",secondArea),context());
  await buildCoverageRegion(region("neighbor"),context());
  const before=await release(), files=await Promise.all(before.artifacts.map(artifact=>readFile(path.join(root,"release",artifact.path))));
  const neighbor=before.artifacts.find(artifact=>artifact.regionId==="neighbor")!;
  await buildCoverageRegion({...region("consolidated",consolidatedArea),replaces:["pilot-one","pilot-two"]},context());
  const after=await release();
  expect(after.sections.map(section=>section.id)).toEqual(["consolidated","neighbor"]);
  expect(after.sections.find(section=>section.id==="consolidated")!.replaces).toEqual(["pilot-one","pilot-two"]);
  expect(after.regions.map(region=>region.id)).toEqual(["consolidated","neighbor"]);
  expect(after.artifacts.map(artifact=>artifact.regionId).sort()).toEqual(["consolidated","neighbor"]);
  expect(after.artifacts.find(artifact=>artifact.regionId==="neighbor")).toEqual(neighbor);
  expect(after.sources.filter(source=>source.id.startsWith("region-")).map(source=>source.id)).toEqual([
    "region-approaches-consolidated","region-approaches-neighbor","region-boundary-consolidated","region-boundary-neighbor",
  ]);
  expect(after.sources.filter(source=>!source.id.startsWith("region-"))).toEqual(before.sources.filter(source=>!source.id.startsWith("region-")));
  for (const [index,artifact] of before.artifacts.entries())
    expect(await readFile(path.join(root,"release",artifact.path))).toEqual(files[index]);
});
it.each(["drop","hole","routing exclusion"])("refuses replacement with a coverage %s before source verification or preparation",async kind=>{
  await buildCoverageRegion(region("pilot"),context());
  const before=await readFile(path.join(root,"release/release.json"),"utf8");
  const replacement={...region("consolidated",consolidatedArea),replaces:["pilot"]};
  if(kind==="drop") replacement.geometry=secondArea;
  if(kind==="hole") replacement.geometry=subtractCoverage(consolidatedArea,rectangle([-121.265,47.505,-121.255,47.515]))!;
  if(kind==="routing exclusion") replacement.recipe.exclusions=[{id:"new-exclusion",geometry:rectangle([-121.4,47.6,-121.39,47.61])}];
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source"), {elevationFor}=await import("./elevation");
  vi.mocked(readPinnedOsmSnapshot).mockClear();vi.mocked(filteredSourceLines).mockClear();vi.mocked(elevationFor).mockClear();
  await expect(buildCoverageRegion(replacement,context())).rejects.toThrow(kind==="routing exclusion"?"complete routing coverage":"complete eligible-start coverage");
  expect(readPinnedOsmSnapshot).not.toHaveBeenCalled();expect(filteredSourceLines).not.toHaveBeenCalled();expect(elevationFor).not.toHaveBeenCalled();
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(before);
  await expectNoScratch();
});
it("applies current retirement metadata to a reused graph and does not resurrect retired areas on later cached rebuilds",async()=>{
  await buildCoverageRegion(region("pilot-one"),context());
  await buildCoverageRegion(region("pilot-two",secondArea),context());
  const replacement=region("consolidated",consolidatedArea);
  await buildCoverageRegion(replacement,context());
  const before=await release(), artifact=before.artifacts.find(artifact=>artifact.regionId==="consolidated")!;
  const bytes=await readFile(path.join(root,"release",artifact.path));
  const {elevationFor}=await import("./elevation"), {writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  vi.mocked(elevationFor).mockClear();vi.mocked(writeProgressiveTopology).mockClear();vi.mocked(filteredSourceLines).mockClear();
  replacement.replaces=["pilot-one","pilot-two"];
  await buildCoverageRegion(replacement,context());
  const after=await release();
  expect(after.sections).toEqual([expect.objectContaining({id:"consolidated",replaces:["pilot-one","pilot-two"]})]);
  expect(after.artifacts).toEqual([artifact]);
  await buildCoverageRegion(replacement,context());
  expect(await release()).toEqual(after);
  expect(await readFile(path.join(root,"release",artifact.path))).toEqual(bytes);
  expect(elevationFor).not.toHaveBeenCalled();expect(writeProgressiveTopology).not.toHaveBeenCalled();expect(filteredSourceLines).not.toHaveBeenCalled();
  await buildCoverageRegion(region("neighbor"),context());
  expect((await release()).sections.find(section=>section.id==="consolidated")!.replaces).toEqual(["pilot-one","pilot-two"]);
});
it.each(["failed approach","cancelled publication"])("keeps pilot publication intact after %s",async kind=>{
  await buildCoverageRegion(region("pilot"),context());
  const before=await readFile(path.join(root,"release/release.json"),"utf8");
  const replacement={...region("consolidated",consolidatedArea),replaces:["pilot"]};
  const controller=new AbortController(), ctx={...context(),signal:controller.signal};
  if(kind==="failed approach") replacement.reviewedApproaches=[{id:"missing",name:"Missing entrance",coordinates:[-121.2,47.52],radiusMeters:50}];
  else ctx.report=async update=>{if(update.stage?.startsWith("Publishing ")) controller.abort();};
  await expect(buildCoverageRegion(replacement,ctx)).rejects.toThrow(kind==="failed approach"?"Reviewed approaches have no mapped starting point":"Coverage build interrupted");
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(before);
  await expectNoScratch();
});
it("keeps shared provider pin conflicts as errors during retirement",async()=>{
  await buildCoverageRegion(region("pilot"),context());
  await buildCoverageRegion(region("neighbor",secondArea),context());
  const before=await release(), replacement={...region("consolidated",consolidatedArea),replaces:["pilot"]};
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,contentHash:`sha256:${"2".repeat(64)}`});
  replacement.recipe.sources[0]!.sha256=`sha256:${"2".repeat(64)}`;
  await expect(buildCoverageRegion(replacement,context())).rejects.toThrow("Conflicting source metadata fixture");
  expect(await release()).toEqual(before);
});
it("checks every reviewed approach after final start filtering and preserves publication on failure",async()=>{
  const region={id:"first-region",name:"First region",geometry:startArea,recipe:recipe(),reviewedApproaches:[
    {id:"mapped",name:"Mapped entry",coordinates:[-121.26,47.51] as [number,number],radiusMeters:500},
  ]};
  await buildCoverageRegion(region,context());
  const before=await release();
  region.reviewedApproaches.push({id:"missing",name:"Missing entrance",coordinates:[-121.25,47.54],radiusMeters:500});
  await expect(buildCoverageRegion(region,context())).rejects.toThrow("Reviewed approaches have no mapped starting point in the final graph: Missing entrance (500 m)");
  expect(await release()).toEqual(before);
  await expectNoScratch();
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
  const receiptFile=path.join(root,"stage/regions",(await readdir(path.join(root,"stage/regions")))[0]!);
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
  const access=await import("@/lib/data/curated-access");
  vi.spyOn(access,"readCuratedAccessFile").mockResolvedValue({snapshot:{...source,id:"review"},restrictions:[{externalId:"way/201",accessState:"closed",reason:"reviewed closure",review:{reviewedAt:source.retrievedAt,reviewer:"fixture"}}]});
  await build(startArea,context(),{...recipe(),reviewedRegionIds:["missing-fixture-region"]});
  const edges=(await pieces())[0]!.edges;
  expect(edges.length).toBeGreaterThan(0);expect(edges.flatMap(edge=>JSON.parse(String(edge.geometry))).some(point=>point[0]===-121.1)).toBe(false);
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
  expect((await pieces())[0]!.edges.flatMap(edge=>JSON.parse(String(edge.geometry))).some(point=>point[0]===-121.24)).toBe(true);
});

it("does not acquire elevation or publish when the local buffer has no eligible links",async()=>{
  fixtureLines=[];
  await expect(build()).rejects.toThrow("No eligible walking links");
  const {elevationFor,describeCanonicalElevation}=await import("./elevation");
  expect(elevationFor).not.toHaveBeenCalled();expect(describeCanonicalElevation).not.toHaveBeenCalled();
  await expectNoScratch();
});

it("plans elevation only for retained sample-owner tiles and reports useful work and resource counts",async()=>{
  const {elevationFor}=await import("./elevation");
  const updates:unknown[]=[];const ctx=context();ctx.report=async update=>{updates.push(update);};
  await build(startArea,ctx);
  expect(vi.mocked(elevationFor).mock.calls[0]![0].geometry).toEqual(unionCoverage([rectangle([-122,47,-121,48])]));
  expect(vi.mocked(calculateEdgeMetricsBatch).mock.calls.reduce((sum,call)=>sum+call[0].length,0)).toBe(3);
  expect(updates).toContainEqual(expect.objectContaining({counts:expect.objectContaining({candidateSegments:6,retainedSegments:3})}));
  expect(updates).toContainEqual(expect.objectContaining({peakMeasuredMemoryBytes:expect.any(Number),peakDiskBytes:expect.any(Number)}));
});
it("reuses geometry measurements after source segment ordinals change",async()=>{
  await build();
  fixtureLines=fixtureLines.map(line=>line.startsWith("w101 ")?line.replace("Nn1,n2,n3,n1","Nn2,n3,n1,n2"):line);
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  const changed={...source,contentHash:`sha256:${"2".repeat(64)}` as const};
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(changed);
  const input=recipe();input.sources[0]!.sha256=changed.contentHash;
  vi.mocked(calculateEdgeMetricsBatch).mockClear();await build(startArea,context(),input);
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
});
