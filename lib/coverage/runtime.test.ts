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
import { contentId, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import { buildCoverageRegion } from "./runtime";
import { calculateEdgeMetricsBatch, type EdgeMetrics } from "@/lib/data/metrics";
import { inspectPreparedRelease, preparedReleaseId } from "@/lib/data/prepared-release";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
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
const secondNetwork=["n11 T x-121.12 y47.51","n12 T x-121.10 y47.51","n13 T x-121.11 y47.54","n14 T x-121.121 y47.509","w200 Thighway=residential Nn14,n11","w201 Thighway=path,foot=yes,name=Second%20%loop Nn11,n12,n13,n11"];
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
  vi.mocked(elevationFor).mockResolvedValue({ source: { ...source, id: "dem" }, productFingerprint: "fixture-dem", fingerprintForGeometry: () => "fixture-dem", limitations: [], sampler: { algorithmVersion: "fixture", sample: async (coordinates) => coordinates.map(() => 100) } });
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
      sources:db.prepare("SELECT * FROM sources ORDER BY id").all(),
      entranceFamilies:db.prepare("SELECT * FROM access_entrance_families ORDER BY profile,access_point_id").all(),
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
it("publishes short alternate entrance families while retaining every original start and approach",async()=>{
  fixtureLines=fixtureLines.map(line=>line.startsWith("w101 ")?line.replace("Nn1,n2,n3,n1","Nn8,n2,n3,n8"):line);
  fixtureLines.splice(fixtureLines.findIndex(line=>line.startsWith("w")),0,
    "n6 Thighway=trailhead,name=Alternate%20%entrance x-121.2598 y47.5102",
    "n7 T x-121.2605 y47.5105","n8 T x-121.263 y47.515");
  fixtureLines.push(
    "w103 Thighway=residential,access=yes Nn4,n6",
    "w104 Thighway=path,foot=yes Nn1,n7,n8","w105 Thighway=path,foot=yes Nn6,n7");
  await build();
  const before=await release(),[piece]=await pieces();
  expect(piece!.access.map(point=>point.node_id)).toEqual(["osm-node-1","osm-node-6"]);
  expect(piece!.entranceFamilies).toHaveLength(4);
  for(const profile of ["known","inclusive"]) {
    const members=piece!.entranceFamilies.filter(member=>member.profile===profile);
    expect(new Set(members.map(member=>member.family_id)).size).toBe(1);
    expect(members.every(member=>member.junction_node_id==="osm-node-7")).toBe(true);
    expect(members.map(member=>member.access_point_id)).toEqual(piece!.access.map(point=>point.id));
    expect(members.every(member=>Number(member.approach_distance_m)>0&&Number(member.approach_distance_m)<250)).toBe(true);
  }
  expect(piece!.nodes.find(node=>node.id==="osm-node-1")).toMatchObject({lon:-121.26,lat:47.51});
  expect(piece!.nodes.find(node=>node.id==="osm-node-6")).toMatchObject({lon:-121.2598,lat:47.5102});
  expect(piece!.edges.flatMap(edge=>JSON.parse(String(edge.geometry))).some(point=>point[0]===-121.2605&&point[1]===47.5105)).toBe(true);
  vi.mocked(filteredSourceLines).mockClear();
  await build();
  expect(await release()).toEqual(before);
  expect(filteredSourceLines).not.toHaveBeenCalled();
  await expectNoScratch();
});
const buildingsAt=(lon:number,lat:number,count:number)=>Array.from({length:count},(_,i)=>`n${9000+i} Tbuilding=yes x${lon+i*.00001} y${lat}`);
it("retains dense connected entrances and measures their hiking network",async()=>{
  fixtureLines.push(...buildingsAt(-121.12,47.51,10));
  const input=region("both",consolidatedArea);
  input.reviewedApproaches=[{id:"dense",name:"Dense entrance",coordinates:[-121.12,47.51],radiusMeters:100}];
  await buildCoverageRegion(input,context());
  const measured=vi.mocked(calculateEdgeMetricsBatch).mock.calls.flatMap(([geometries])=>geometries.flat());
  expect(measured.length).toBeGreaterThan(0);
  expect(measured.some(([lon])=>lon> -121.2)).toBe(true);
  const [piece]=await pieces();
  expect(piece!.access.length).toBeGreaterThan(0);
  expect(piece!.access.every(point=>point.nearby_building_count===null)).toBe(true);
  expect((await release()).limitations.some(message=>message.includes("buildings-within"))).toBe(false);
  await expectNoScratch();
});
it("retains a start with nine nearby buildings",async()=>{
  fixtureLines.push(...buildingsAt(-121.26,47.51,9));
  await build();
  const access=(await pieces())[0]!.access;
  expect(access.length).toBeGreaterThan(0);
  expect(access.every(point=>point.nearby_building_count===null)).toBe(true);
});
it("filters lowland starts before elevation while preserving an unmarked valley approach and reporting reviewed exclusions",async()=>{
  // The first loop's entrance is outside terrain, connected to its mountain end.
  const input=region("both",rectangle([-121.245,47.50,-121.235,47.52]));
  input.reviewedApproaches=[{id:"lowland",name:"Lowland entrance",coordinates:[-121.12,47.51],radiusMeters:100}];
  await buildCoverageRegion(input,context());
  const measured=vi.mocked(calculateEdgeMetricsBatch).mock.calls.flatMap(([geometries])=>geometries.flat());
  expect(measured.every(([lon])=>lon< -121.2)).toBe(true);
  const result=await release(),[piece]=await pieces();
  expect(piece!.access.some(point=>point.confidence==="low" && point.node_id==="osm-node-1")).toBe(true);
  expect(result.sources.some(source=>source.id==="region-boundary-both")).toBe(true);
  expect(result.limitations).toContain("Reviewed approaches excluded because no mountain hiking trail is reachable within the route-distance bound: Lowland entrance.");
});
it("fails an all-lowland selection before elevation and preserves the published neighbor",async()=>{
  await build();
  const prior=await release(),{elevationFor}=await import("./elevation");
  vi.mocked(elevationFor).mockClear();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await expect(build(rectangle([-121.02,47.50,-121.01,47.52]))).rejects.toThrow("connect to mountain hiking trails");
  expect(elevationFor).not.toHaveBeenCalled();expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(await release()).toEqual(prior);
  await expectNoScratch();
});
it("preserves mountain fire-road hikes but ambiguous walking links cannot qualify terrain alone",async()=>{
  fixtureLines=fixtureLines.map(line=>line.replace("highway=path","highway=track"));
  await build();
  expect((await pieces())[0]!.edges.length).toBeGreaterThan(0);
  const prior=await release(),{elevationFor}=await import("./elevation");
  fixtureLines=fixtureLines.map(line=>line.replace("highway=track,foot=yes,name=Second%20%loop","highway=footway,foot=yes"));
  vi.mocked(elevationFor).mockClear();
  await expect(build(secondArea)).rejects.toThrow("connect to mountain hiking trails");
  expect(elevationFor).not.toHaveBeenCalled();expect(await release()).toEqual(prior);
});
it("retains an entrance when its trail crosses narrow terrain with all source nodes outside",async()=>{
  await build(rectangle([-121.252,47.5099,-121.248,47.5101]));
  expect((await pieces())[0]!.access.some(point=>point.node_id==="osm-node-1")).toBe(true);
});
it("includes named mountain pins in checkpoint identity but reuses unchanged segment measurements",async()=>{
  const input=region("first-region");
  await buildCoverageRegion(input,context());const before=await release();
  input.sources![0]!.contentHash=`sha256:${"2".repeat(64)}`;
  vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await buildCoverageRegion(input,context());
  expect((await release()).id).not.toBe(before.id);
  expect((await release()).sources.find(source=>source.id==="region-boundary-first-region")!.contentHash).toBe(`sha256:${"2".repeat(64)}`);
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
});
it("completes routes going away from an outside approach without nominating support-area entrances, and resumes the derived extent",async()=>{
  fixtureLines=["n1 T x-121.57 y47.51","n2 T x-121.045 y47.51","n3 T x-121.571 y47.51",
    "n11 Thighway=trailhead x-121.80 y47.51","n12 T x-121.69 y47.54",
    "w500 Thighway=residential Nn3,n1","w501 Thighway=path,foot=yes Nn1,n2",
    "w502 Thighway=path,foot=yes Nn1,n11,n12,n1"];
  const input=region("approach",rectangle([-121.05,47.50,-121.04,47.52]));
  await buildCoverageRegion(input,context());
  const first=await release(),[piece]=await pieces();
  expect(piece!.access.map(row=>row.node_id)).toEqual(["osm-node-1"]);
  expect(piece!.edges.flatMap(row=>JSON.parse(String(row.geometry))).some(point=>point[0]===-121.80)).toBe(true);
  expect(first.sections[0]!.geometry).not.toEqual(input.geometry);
  const {elevationFor}=await import("./elevation");
  vi.mocked(elevationFor).mockClear();vi.mocked(filteredSourceLines).mockClear();
  await buildCoverageRegion(input,context());
  expect(await release()).toEqual(first);
  expect(elevationFor).not.toHaveBeenCalled();expect(filteredSourceLines).not.toHaveBeenCalled();
});
it("rejects a new approach's missing route support before DEM and preserves published data",async()=>{
  await build();const prior=await release();
  fixtureLines=["n1 T x-121.57 y47.51","n2 T x-121.045 y47.51","n3 T x-121.571 y47.51",
    "w500 Thighway=residential Nn3,n1","w501 Thighway=path,foot=yes Nn1,n2"];
  const input=region("gap",rectangle([-121.05,47.50,-121.04,47.52]));
  input.recipe.sources[0]!.geometry=rectangle([-121.7,46,-119,49]);
  const {elevationFor}=await import("./elevation");vi.mocked(elevationFor).mockClear();
  await expect(buildCoverageRegion(input,context())).rejects.toThrow("complete 25-mile route buffer");
  expect(elevationFor).not.toHaveBeenCalled();expect(await release()).toEqual(prior);
  await expectNoScratch();
});
it("publishes a dense selection while preserving its neighbor",async()=>{
  fixtureLines.push(...buildingsAt(-121.12,47.51,10));
  await build();
  const prior=await release(),{elevationFor}=await import("./elevation");
  vi.mocked(elevationFor).mockClear();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await expect(build(secondArea)).resolves.toMatchObject({status:"completed"});
  expect(elevationFor).toHaveBeenCalled();expect(calculateEdgeMetricsBatch).toHaveBeenCalled();
  expect((await release()).artifacts).toEqual(expect.arrayContaining(prior.artifacts));
  await expectNoScratch();
});
async function expectNoScratch(){expect((await readdir(path.join(root,"stage"))).filter(file=>file.startsWith(".region-"))).toEqual([]);}

it("accounts for external scratch, retains caches and cleans it after success or interruption",async()=>{
  await build();
  const before=await release(),graph=await pieces();
  const scratchRoot=path.join(root,"external-scratch");
  vi.stubEnv("ALPINE_BUILD_SCRATCH",scratchRoot);
  let peakDisk=0,observedScratch=false;
  const run=context();
  run.report=async update=>{
    peakDisk=Math.max(peakDisk,update.peakDiskBytes??0);
    if(update.stage?.startsWith("Reading walking links")) {
      const directories=await readdir(scratchRoot);
      expect(directories).toHaveLength(1);
      const directory=path.join(scratchRoot,directories[0]!);
      expect((await stat(path.join(directory,"stage.sqlite"))).isFile()).toBe(true);
      // Resource reporting must include temporary storage outside the cache root.
      await writeFile(path.join(directory,"disk-accounting-fixture"),Buffer.alloc(2*1024**2));
      observedScratch=true;
    }
  };
  const input={id:"first-region",name:"First region",geometry:startArea,recipe:recipe()};
  vi.mocked(calculateEdgeMetricsBatch).mockClear();vi.mocked(filteredSourceLines).mockClear();
  await buildCoverageRegion(input,run,{rebuild:true});
  expect(observedScratch).toBe(true);expect(peakDisk).toBeGreaterThanOrEqual(2*1024**2);
  expect(await pieces()).toEqual(graph);expect(await release()).toEqual(before);
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();expect(filteredSourceLines).not.toHaveBeenCalled();
  expect(await readdir(scratchRoot)).toEqual([]);
  const interrupted=context();
  interrupted.report=async update=>{if(update.stage?.startsWith("Compressing trail paths"))throw new Error("interrupted external scratch");};
  await expect(buildCoverageRegion(input,interrupted,{rebuild:true})).rejects.toThrow("interrupted external scratch");
  expect(await release()).toEqual(before);expect(await readdir(scratchRoot)).toEqual([]);
  await expectNoScratch();
});

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
async function useAcquisitionDate(retrievedAt:string) {
  const snapshot={...source,retrievedAt};
  const {inspectPinnedOsmSnapshot,readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(inspectPinnedOsmSnapshot).mockResolvedValue(snapshot);
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(snapshot);
  const {elevationFor,describeCanonicalElevation}=await import("./elevation");
  vi.mocked(elevationFor).mockResolvedValue({source:{...snapshot,id:"dem"},productFingerprint:"fixture-dem",fingerprintForGeometry:()=>"fixture-dem",limitations:[],sampler:{algorithmVersion:"fixture",sample:async coordinates=>coordinates.map(()=>100)}});
  vi.mocked(describeCanonicalElevation).mockResolvedValue({source:{...snapshot,id:"dem"},productFingerprint:"fixture-dem"});
}
it.each(["2026-09-23T12:00:00Z","2026-09-25T12:00:00Z"])("merges adjacent areas acquired at %s using the earliest date independently of publication order",async neighborDate=>{
  await build();const first=await release(),artifact=first.artifacts[0]!,before=await readFile(path.join(root,"release",artifact.path));
  await useAcquisitionDate(neighborDate);
  await build(secondArea);
  const merged=await release(),earliestDate=[source.retrievedAt,neighborDate].sort()[0]!;
  expect(merged.sections).toHaveLength(2);
  expect(merged.sources.every(source=>source.retrievedAt===earliestDate)).toBe(true);
  const graphs=await pieces();
  for(const [index,item] of merged.artifacts.entries())
    expect(graphs[index]!.sources.every(row=>row.retrieved_at===(item.regionId==="first-region"?source.retrievedAt:neighborDate))).toBe(true);
  expect(await readFile(path.join(root,"release",artifact.path))).toEqual(before);
  expect(await inspectPreparedRelease(path.join(root,"release/release.json"))).toMatchObject({verified:true,sections:2});
  // Reuse both immutable checkpoints in reverse order, without changing their dates.
  await rm(path.join(root,"release/release.json"));
  await build(secondArea);
  await useAcquisitionDate(source.retrievedAt);
  await build();
  expect(await release()).toEqual(merged);
  expect(await readFile(path.join(root,"release",artifact.path))).toEqual(before);
  const latestDate=[source.retrievedAt,neighborDate].sort().at(-1)!;
  expect(merged.builtAt).toBe(latestDate);
  await useAcquisitionDate("2026-09-22T12:00:00Z");
  await buildCoverageRegion({id:"third-region",name:"Third region",geometry:startArea,recipe:recipe()},context());
  expect((await release()).builtAt).toBe(latestDate);
});
it("retries a saved area receipt after a source-date publication conflict without repeating graph or elevation work",async()=>{
  await build();const prior=await readFile(path.join(root,"release/release.json"),"utf8");
  await useAcquisitionDate("2026-09-25T12:00:00Z");
  const interrupted=context();
  // Older builders raised this error after the area had already been exported and saved.
  interrupted.report=async update=>{if(update.stage?.startsWith("Prepared "))throw new Error("Conflicting source metadata fixture");};
  await expect(build(secondArea,interrupted)).rejects.toThrow("Conflicting source metadata fixture");
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(prior);
  const receipts=await Promise.all((await readdir(path.join(root,"stage/regions"))).map(async name=>{
    const file=path.join(root,"stage/regions",name),bytes=await readFile(file);
    return {file,bytes,release:(JSON.parse(bytes.toString()) as {release:DataRelease}).release};
  }));
  const saved=receipts.find(receipt=>receipt.release.sections[0]!.id==="second-region")!;
  expect(saved.release.sources.every(source=>source.retrievedAt==="2026-09-25T12:00:00Z")).toBe(true);
  const artifact=saved.release.artifacts[0]!,file=path.join(root,"release",artifact.path),bytes=await readFile(file);
  const {elevationFor}=await import("./elevation"),{writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  vi.mocked(elevationFor).mockClear();vi.mocked(writeProgressiveTopology).mockClear();vi.mocked(filteredSourceLines).mockClear();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build(secondArea);
  expect(elevationFor).not.toHaveBeenCalled();expect(writeProgressiveTopology).not.toHaveBeenCalled();expect(filteredSourceLines).not.toHaveBeenCalled();expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(await readFile(saved.file)).toEqual(saved.bytes);
  expect(await readFile(file)).toEqual(bytes);
  expect((await release()).sources.every(item=>item.retrievedAt===source.retrievedAt)).toBe(true);
  expect(await inspectPreparedRelease(path.join(root,"release/release.json"))).toMatchObject({verified:true,sections:2});
  await expectNoScratch();
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
const unavailableReason="Reviewed unavailable start Missing entrance: the pinned source has no mapped parking-to-trail contacts; this start is unavailable without adding a connector.";
const unavailableStart=()=>({sourceId:source.id,sourceHash:source.contentHash,reviewedAt:"2026-09-29T00:00:00Z",reason:unavailableReason});
const missingReviewedApproach=()=>({id:"missing",name:"Missing entrance",coordinates:[-121.25,47.54] as [number,number],radiusMeters:100,unavailableStart:unavailableStart()});
it("publishes only a pinned reviewed gap as a limitation without adding starts or trails, and retains it on reuse",async()=>{
  const input=region("first-region");
  await buildCoverageRegion(input,context());
  const [before]=await pieces();
  input.reviewedApproaches=[missingReviewedApproach()];
  const ctx=context();ctx.report=vi.fn();
  await buildCoverageRegion(input,ctx);
  const published=await release(),[after]=await pieces();
  expect(after!.access).toEqual(before!.access);
  expect(after!.edges).toEqual(before!.edges);
  expect(after!.nodes).toEqual(before!.nodes);
  expect(published.limitations).toContain(unavailableReason);
  expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({stage:"Reviewed approach checks complete: first-region",counts:expect.objectContaining({unavailableReviewedApproaches:1})}));
  const receipts=await Promise.all((await readdir(path.join(root,"stage/regions"))).map(async file=>JSON.parse(await readFile(path.join(root,"stage/regions",file),"utf8"))));
  expect(receipts.find(receipt=>receipt.release.limitations.includes(unavailableReason))).toMatchObject({unavailableReviewedApproaches:1});
  vi.mocked(filteredSourceLines).mockClear();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  const {elevationFor}=await import("./elevation");vi.mocked(elevationFor).mockClear();vi.mocked(ctx.report).mockClear();
  await buildCoverageRegion(input,ctx);
  expect(await release()).toEqual(published);
  expect(filteredSourceLines).not.toHaveBeenCalled();expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();expect(elevationFor).not.toHaveBeenCalled();
  expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({stage:"Reused first-region",counts:{reusedRegions:1,unavailableReviewedApproaches:1}}));
  expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({stage:"Ready: first-region",counts:{unavailableReviewedApproaches:1}}));
  await expectNoScratch();
});
it("keeps an actually mapped start eligible despite a reviewed gap declaration and emits no unavailable warning",async()=>{
  const input=region("first-region");
  input.reviewedApproaches=[{...missingReviewedApproach(),coordinates:[-121.26,47.51]}];
  const ctx=context();ctx.report=vi.fn();
  await buildCoverageRegion(input,ctx);
  expect((await pieces())[0]!.access.some(point=>point.node_id==="osm-node-1")).toBe(true);
  expect((await release()).limitations).not.toContain(unavailableReason);
  expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({stage:"Reviewed approach checks complete: first-region",counts:expect.objectContaining({unavailableReviewedApproaches:0})}));
});
it.each(["density","terrain"])("reports an actual %s policy exclusion before an unavailable declaration",async kind=>{
  const input=region("both",kind==="density"?consolidatedArea:rectangle([-121.245,47.50,-121.235,47.52]));
  input.reviewedApproaches=[{...missingReviewedApproach(),name:"Second entrance",coordinates:[-121.12,47.51]}];
  if(kind==="density") fixtureLines.push(...buildingsAt(-121.12,47.51,10));
  const ctx=context();ctx.report=vi.fn();
  await buildCoverageRegion(input,ctx);
  const published=await release();
  expect(published.limitations).not.toContain(unavailableReason);
  expect(published.limitations.some(reason=>reason.startsWith("Reviewed approaches excluded")&&reason.includes("Second entrance"))).toBe(kind==="terrain");
  expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({stage:"Reviewed approach checks complete: both",counts:expect.objectContaining({unavailableReviewedApproaches:0})}));
});
it.each(["stale hash","missing input"])("rejects a reviewed gap with %s against verified inputs before normalization or elevation",async kind=>{
  const input=region("first-region");
  await buildCoverageRegion(input,context());
  const before=await release(), {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source"),{elevationFor}=await import("./elevation");
  input.reviewedApproaches=[missingReviewedApproach()];
  if(kind==="stale hash") {
    const changed={...source,contentHash:`sha256:${"2".repeat(64)}` as const};
    // The recipe agrees with the verified bytes; the review still pins the old source.
    input.recipe.sources[0]!.sha256=changed.contentHash;
    vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(changed);
  } else {
    // A matching recipe hash alone cannot stand in for the required source identity.
    vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,id:"other-source"});
  }
  vi.mocked(filteredSourceLines).mockClear();vi.mocked(elevationFor).mockClear();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await expect(buildCoverageRegion(input,context())).rejects.toThrow(kind==="stale hash"?"actual hash is":"source is absent from verified inputs");
  expect(filteredSourceLines).not.toHaveBeenCalled();expect(elevationFor).not.toHaveBeenCalled();expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(await release()).toEqual(before);await expectNoScratch();
});
it.each([
  {sourceId:""},{sourceHash:"not-a-hash"},{reviewedAt:"not-a-date"},{reason:"  "},{unexpected:"extra"},
])("rejects a malformed direct-call reviewed gap before preparation: %j",async malformed=>{
  const input=region("first-region"),{elevationFor}=await import("./elevation");
  input.reviewedApproaches=[{...missingReviewedApproach(),unavailableStart:{...unavailableStart(),...malformed}}];
  await expect(buildCoverageRegion(input,context())).rejects.toThrow();
  expect(filteredSourceLines).not.toHaveBeenCalled();expect(elevationFor).not.toHaveBeenCalled();
  await expectNoScratch();
});
it("still blocks an undeclared second missing approach while preserving a published reviewed gap",async()=>{
  const input=region("first-region");
  input.reviewedApproaches=[missingReviewedApproach()];
  await buildCoverageRegion(input,context());
  const before=await release();
  input.reviewedApproaches.push({id:"other-missing",name:"Undeclared entrance",coordinates:[-121.24,47.55],radiusMeters:100});
  await expect(buildCoverageRegion(input,context())).rejects.toThrow("Reviewed approaches have no mapped starting point in the final graph: Undeclared entrance (100 m)");
  expect(await release()).toEqual(before);await expectNoScratch();
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
it("explicitly rebuilds a rejected checkpoint using cached inputs and publishes only after success",async()=>{
  const input=region("first-region");
  // Match the non-schema source field order used by the named-region catalog.
  input.sources=input.sources!.map(source=>{const {version,retrievedAt,...rest}=source;return {version,retrievedAt,...rest};});
  await buildCoverageRegion(input,context());
  const before=await readFile(path.join(root,"release/release.json"),"utf8");
  const receiptFile=path.join(root,"stage/regions",(await readdir(path.join(root,"stage/regions")))[0]!);
  const receipt=JSON.parse(await readFile(receiptFile,"utf8"));
  receipt.release.id="old-order-checkpoint";
  const rejected=JSON.stringify(receipt);await writeFile(receiptFile,rejected);
  await expect(buildCoverageRegion(input,context())).rejects.toThrow("--rebuild");
  const paused=context();paused.report=async update=>{if(update.stage?.startsWith("Writing prepared graph:"))throw new Error("paused rebuild");};
  await expect(buildCoverageRegion(input,paused,{rebuild:true})).rejects.toThrow("paused rebuild");
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(before);
  expect(await readFile(receiptFile,"utf8")).toBe(rejected);
  vi.mocked(calculateEdgeMetricsBatch).mockClear();vi.mocked(filteredSourceLines).mockClear();
  const {writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  vi.mocked(writeProgressiveTopology).mockClear();
  await buildCoverageRegion(input,context(),{rebuild:true});
  expect(writeProgressiveTopology).toHaveBeenCalledOnce();
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(filteredSourceLines).not.toHaveBeenCalled();
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(before);
  vi.mocked(writeProgressiveTopology).mockClear();
  await buildCoverageRegion(input,context());
  expect(writeProgressiveTopology).not.toHaveBeenCalled();
  await expectNoScratch();
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
  fixtureLines=["n1 T x-121.26 y47.51","n2 T x-121.24 y47.51","n3 T x-119.9 y47.52","n4 T x-121.261 y47.51","w100 Thighway=residential Nn4,n1","w101 Thighway=path,foot=yes Nn1,n2,n3"];
  await build();expect((await pieces())[0]!.edges).toHaveLength(2);
});
it("applies access restrictions before compiling eligible local segments",async()=>{
  const access=await import("@/lib/data/curated-access");
  vi.spyOn(access,"readCuratedAccessFile").mockResolvedValue({snapshot:{...source,id:"review"},restrictions:[{externalId:"way/201",accessState:"closed",reason:"reviewed closure",review:{reviewedAt:source.retrievedAt,reviewer:"fixture"}}]});
  await build(startArea,context(),{...recipe(),reviewedRegionIds:["missing-fixture-region"]});
  const edges=(await pieces())[0]!.edges;
  expect(edges.length).toBeGreaterThan(0);expect(edges.flatMap(edge=>JSON.parse(String(edge.geometry))).some(point=>point[0]===-121.1)).toBe(false);
});
it.each([
  {version:"2"},
  {contentHash:`sha256:${"2".repeat(64)}` as const},
  {url:"https://example.invalid/another-source"},
  {license:"ODbL-1.0"},
])("does not silently combine different source pins across prepared areas: %j",async change=>{
  await build();const before=await release();
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  const changed={...source,...change,retrievedAt:"2026-09-25T12:00:00Z"};
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(changed);
  const input=recipe();input.sources[0]!.sha256=changed.contentHash;
  input.sources[0]!.config={...input.sources[0]!.config,version:changed.version,url:changed.url,license:changed.license};
  await expect(build(secondArea,context(),input)).rejects.toThrow("Conflicting source metadata");
  expect(await release()).toEqual(before);
});
it("ignores unrelated building relations and reuses the completed area",async()=>{
  fixtureLines.push("r30 Ttype=multipolygon,building=yes Mw999@outer");
  await build();const before=await release();
  expect(before.limitations.some(message=>message.includes("building"))).toBe(false);
  expect((await pieces())[0]!.access.length).toBeGreaterThan(0);
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
  await expect(build()).rejects.toThrow("No eligible access points");
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

const fallbackLimitation="30 m elevation fills missing 10 m samples; primary values remain unchanged.";
async function dynamicElevation(options:{sampleValue?:number|null;onSample?:()=>void}={}) {
  const state={fallback:false};
  const primary={...source,id:"dem"},backup={...source,id:"dem-with-backup",contentHash:`sha256:${"3".repeat(64)}` as const,
    dataset:"10 m primary with 30 m NoData backup",retrievedAt:"2026-09-25T00:00:00Z"};
  let reportBackup:((tile:string|null)=>Promise<void>)|undefined;
  const sample=vi.fn(async(coordinates:ReadonlyArray<readonly[number,number]>)=>{
    await reportBackup?.("-122,47");
    state.fallback=true;
    options.onSample?.();
    await reportBackup?.(null);
    return coordinates.map(()=>options.sampleValue===undefined?100:options.sampleValue);
  });
  const elevation={
    get source(){return state.fallback?backup:primary;},
    get productFingerprint(){return state.fallback?"fixture-dem-with-backup":"fixture-dem";},
    get limitations(){return state.fallback?[fallbackLimitation]:[];},
    fingerprintForGeometry:()=>state.fallback?"fixture-dem-with-backup":"fixture-dem",
    sampler:{algorithmVersion:"fixture",sample},
  };
  const {elevationFor,describeCanonicalElevation}=await import("./elevation");
  vi.mocked(elevationFor).mockImplementation(async(_unit,_cacheRoot,_preparationRoot,_offline,_cache,_samplePath,onBackup)=>{
    reportBackup=onBackup;
    return elevation;
  });
  vi.mocked(describeCanonicalElevation).mockImplementation(async()=>({source:elevation.source,productFingerprint:elevation.productFingerprint}));
  return {state,elevation,sample};
}
function metricsCache<T>(action:(db:DatabaseSync)=>T):T {
  const db=new DatabaseSync(path.join(root,"stage/metrics.sqlite"));
  try {return action(db);} finally {db.close();}
}
const cachedMetrics=()=>metricsCache(db=>db.prepare("SELECT id,fingerprint,value FROM metrics ORDER BY id,fingerprint").all());
const clearReceipts=()=>rm(path.join(root,"stage/regions"),{recursive:true,force:true});
const metricFingerprint=(geometry:ReadonlyArray<readonly[number,number]>,elevation:string)=>contentId({geometry,
  algorithm:PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION,sampler:"fixture",elevation});

it("pins elevation acquired during measurement in graph bytes, identity, receipt and disclosures, then resumes without sampling",async()=>{
  const {elevation,sample}=await dynamicElevation(), stages:string[]=[];
  const ctx=context();ctx.report=async update=>{if(update.stage)stages.push(update.stage);};
  await build(startArea,ctx);
  const result=await release(),[piece]=await pieces();
  const receiptFile=(await readdir(path.join(root,"stage/regions")))[0]!;
  const receipt=JSON.parse(await readFile(path.join(root,"stage/regions",receiptFile),"utf8")) as {release:DataRelease;elevationFingerprint:string};
  expect(sample).toHaveBeenCalled();
  expect(receipt.elevationFingerprint).toBe("fixture-dem-with-backup");
  expect(result.sources.find(source=>source.id===elevation.source.id)?.contentHash).toBe(elevation.source.contentHash);
  expect(result.sources.some(source=>source.id==="dem")).toBe(false);
  expect(piece!.sources).toContainEqual(expect.objectContaining({id:elevation.source.id,content_hash:elevation.source.contentHash}));
  expect(receipt.release.sources).toEqual(result.sources);
  expect(result.builtAt).toBe(elevation.source.retrievedAt);
  expect(result.limitations).toContain(fallbackLimitation);
  expect(receipt.release.limitations).toContain(fallbackLimitation);
  const identity=(fingerprint:string)=>preparedReleaseId({...receipt.release,area:{id:"first-region",name:"First region",
    inputFingerprint:contentId({declared:receiptFile.slice(0,-5),elevationFingerprint:fingerprint}),
    startGeometry:startArea,maximumRouteMiles:40,bufferMiles:25}});
  expect(result.artifacts[0]!.graphId).toBe(identity("fixture-dem-with-backup"));
  expect(result.artifacts[0]!.graphId).not.toBe(identity("fixture-dem"));
  expect(piece!.metadata).toContainEqual({key:"releaseId",value:result.artifacts[0]!.graphId});
  expect(stages).toContain("Acquiring 30 m elevation backup for -122,47");
  expect(stages[stages.indexOf("Acquiring 30 m elevation backup for -122,47")+1]).toBe("Measuring retained trails: First region");
  const {elevationFor}=await import("./elevation");
  vi.mocked(elevationFor).mockClear();sample.mockClear();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build();
  expect(await release()).toEqual(result);
  expect(elevationFor).not.toHaveBeenCalled();expect(sample).not.toHaveBeenCalled();expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  await expectNoScratch();
});

it("reuses valid geometry metrics without rewriting cache rows or changing the prepared graph",async()=>{
  await build();
  const before=cachedMetrics(), beforeRelease=await release(), beforePieces=await pieces();
  metricsCache(db=>db.exec(`CREATE TABLE metric_writes(id TEXT,fingerprint TEXT);
    CREATE TRIGGER record_metric_write AFTER INSERT ON metrics BEGIN
      INSERT INTO metric_writes VALUES (new.id,new.fingerprint);
    END;`));
  await clearReceipts();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build();
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(metricsCache(db=>db.prepare("SELECT * FROM metric_writes").all())).toEqual([]);
  expect(cachedMetrics()).toEqual(before);
  expect(await release()).toEqual(beforeRelease);
  expect(await pieces()).toEqual(beforePieces);
});

it("rekeys newly sampled metrics after fallback acquisition without relabeling reused primary values",async()=>{
  await build();
  const before=cachedMetrics(),removed=String(before[0]!.fingerprint);
  metricsCache(db=>db.prepare("DELETE FROM metrics WHERE fingerprint=?").run(removed));
  await clearReceipts();
  await dynamicElevation();
  vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build();
  const measured=vi.mocked(calculateEdgeMetricsBatch).mock.calls.flatMap(call=>call[0]);
  expect(measured).toHaveLength(1);
  const after=cachedMetrics();
  expect(after).toHaveLength(before.length);
  expect(after.map(row=>row.fingerprint)).not.toContain(removed);
  expect(after.map(row=>row.fingerprint)).toContain(metricFingerprint(measured[0]!,"fixture-dem-with-backup"));
  for(const prior of before.slice(1)) expect(after).toContainEqual(prior);
});

it.each([{elevationProfile:null},{elevationProfile:[]}])("remeasures an old cached row with missing profile $elevationProfile instead of poisoning a retry",async({elevationProfile})=>{
  await build();
  const first=cachedMetrics()[0]!,metric=JSON.parse(String(first.value)) as EdgeMetrics;
  metricsCache(db=>db.prepare("UPDATE metrics SET value=? WHERE fingerprint=?").run(JSON.stringify({...metric,elevationProfile}),String(first.fingerprint)));
  await clearReceipts();
  vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build();
  expect(vi.mocked(calculateEdgeMetricsBatch).mock.calls.flatMap(call=>call[0])).toHaveLength(1);
  expect(cachedMetrics().every(row=>JSON.parse(String(row.value)).elevationProfile.length>0)).toBe(true);
});

it("retains a valid legacy segment measurement even if its geometry cache row has a missing profile",async()=>{
  await build();
  const geometry=[[-121.26,47.51],[-121.24,47.51]] as [number,number][];
  const key=metricFingerprint(geometry,"fixture-dem"),first=cachedMetrics().find(row=>row.fingerprint===key)!;
  const value=JSON.parse(String(first.value)) as EdgeMetrics;
  metricsCache(db=>{
    db.prepare("INSERT INTO metrics VALUES(?,?,?)").run("osm-way-101:0",key,String(first.value));
    db.prepare("UPDATE metrics SET value=? WHERE id='geometry' AND fingerprint=?").run(JSON.stringify({...value,elevationProfile:null}),key);
  });
  await clearReceipts();vi.mocked(calculateEdgeMetricsBatch).mockClear();
  await build();
  expect(calculateEdgeMetricsBatch).not.toHaveBeenCalled();
  expect(cachedMetrics().find(row=>row.id==="geometry"&&row.fingerprint===key)?.value).toBe(first.value);
});

it.each(["missing samples","cancellation"])("does not cache incomplete metrics or replace publication after %s during fallback sampling",async failure=>{
  await build();
  const prior=await readFile(path.join(root,"release/release.json"),"utf8");
  const before=cachedMetrics(),removed=String(before[0]!.fingerprint);
  metricsCache(db=>db.prepare("DELETE FROM metrics WHERE fingerprint=?").run(removed));
  await clearReceipts();
  const controller=new AbortController();
  await dynamicElevation(failure==="missing samples"?{sampleValue:null}:{onSample:()=>controller.abort()});
  await expect(build(startArea,{...context(),signal:controller.signal})).rejects.toThrow(failure==="missing samples"?/Missing elevation on osm-way-101:[0-9]+/:"Coverage build interrupted");
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(prior);
  expect(cachedMetrics()).toEqual(before.slice(1));
  expect(await readdir(path.join(root,"stage/regions"))).toEqual([]);
  await expectNoScratch();
});
