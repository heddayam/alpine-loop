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
import { CoverageSourceStore } from "./source-store";
import { filteredSourceLines } from "./source-filter";
import { areaBounds } from "@/lib/graph/geometry";
import { PreparedGraphRepository } from "@/lib/graph/prepared-repository";
import { rectangle } from "./geometry";
import { discoverNetworks, buildNetworks } from "./runtime";
import { NetworkInventory } from "./networks";
import type { SourceRecipe } from "./recipe";

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
  vi.mocked(elevationFor).mockResolvedValue({ source: { ...source, id: "dem" }, productFingerprint: "fixture-dem", sampler: { algorithmVersion: "fixture", sample: async (coordinates) => coordinates.map(() => 100) } } as Awaited<ReturnType<typeof elevationFor>>);
  vi.mocked(describeCanonicalElevation).mockResolvedValue({source:{...source,id:"dem"},productFingerprint:"fixture-dem"});
  fixtureLines = [...(await readFile(source.localPath,"utf8")).trim().split("\n"),...secondNetwork];
  vi.mocked(filteredSourceLines).mockImplementation(async function* () { yield* fixtureLines; });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const context = (): CoverageRunnerContext => ({ signal: new AbortController().signal, checkpoint: async () => "continue", report: async () => {} });
const recipe = (): SourceRecipe => ({schemaVersion:1,sources:[{config:{schemaVersion:1,id:source.id,authority:source.authority,dataset:source.dataset,version:source.version,upstreamTimestamp:source.retrievedAt,url:source.url,expectedByteLength:100,license:source.license,attribution:"Fixture"},geometry:rectangle([-122,47,-121,49]),sha256:source.contentHash}],exclusions:[],reviewedRegionIds:[],memoryLimitMiB:4096,offline:true,limitations:[]});
async function build(which: "first" | "all" = "first", ctx = context(), input = recipe()) {
  const {catalogPath,catalog}=await discoverNetworks(input,context());
  const networks=[...catalog.networks].sort((a,b)=>areaBounds(a.geometry)[0]-areaBounds(b.geometry)[0]);
  return buildNetworks(catalogPath,(which==="all"?networks:networks.slice(0,1)).map(network=>network.id),ctx);
}
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
it("exports only an explicitly selected complete network, without edge duplication",async()=>{
  await build();
  const result=await release();
  expect(result.partitioning).toBe("connected-networks");
  expect(result.sections).toHaveLength(1);
  const [piece]=await pieces();
  expect(piece!.edges).toHaveLength(6);
  expect(piece!.nodes.some(node=>node.lon===-121.24)).toBe(true);
  expect(piece!.access.length).toBeGreaterThan(0);
  expect(result.sections[0]!.network).toMatchObject({nodeCount:3,physicalEdgeCount:3});
  expect(result.artifacts[0]!.graphId).toBeTruthy();
  await expectNoScratch();
});
async function expectNoScratch(){expect((await readdir(path.join(root,"stage"))).filter(file=>file.startsWith(".networks-"))).toEqual([]);}

it("adding disconnected B reuses A's immutable bytes without elevation or topology work",async()=>{
  const {elevationFor}=await import("./elevation");
  const {writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  await build();
  const first=await release(), artifact=first.artifacts[0]!;
  vi.mocked(filteredSourceLines).mockClear();
  const modified=(await stat(path.join(root,"release",artifact.path))).mtimeMs;
  vi.mocked(elevationFor).mockClear();vi.mocked(writeProgressiveTopology).mockClear();
  await build("all");
  const second=await release();
  expect(second.sections).toHaveLength(2);
  expect(second.artifacts.find(item=>item.id===artifact.id)).toEqual(artifact);
  expect((await stat(path.join(root,"release",artifact.path))).mtimeMs).toBe(modified);
  expect(elevationFor).toHaveBeenCalledTimes(1);
  expect(writeProgressiveTopology).toHaveBeenCalledTimes(1);
  // Only B needs a new context extract; A's context and the trail source are reused.
  expect(filteredSourceLines).toHaveBeenCalledTimes(1);
  const selection = vi.mocked(filteredSourceLines).mock.calls[0]![2];
  expect(selection.kind).toBe("context");
  if (selection.kind === "context") expect(areaBounds(selection.geometry)[0]).toBeGreaterThan(-121.2);
  const all=(await pieces()).flatMap(piece=>piece.edges);
  expect(new Set(all.map(edge=>edge.edge_key)).size).toBe(12);
  expect(new Set(all.map(edge=>edge.id)).size).toBe(12);
});

it("rebuilding an explicit network ID preserves catalog and artifact identity",async()=>{
  await build();const first=await release();
  await build();expect(await release()).toEqual(first);
});

it("resumes after one completed network and leaves the previous catalog untouched",async()=>{
  await build();const prior=await readFile(path.join(root,"release/release.json"),"utf8");
  const paused=context();paused.report=async update=>{if(update.stage?.startsWith("Prepared "))throw new Error("paused after network");};
  await expect(build("all",paused)).rejects.toThrow("paused after network");
  expect(await readFile(path.join(root,"release/release.json"),"utf8")).toBe(prior);
  await expectNoScratch();
  const {elevationFor}=await import("./elevation"),{writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  vi.mocked(elevationFor).mockClear();vi.mocked(writeProgressiveTopology).mockClear();
  await build("all");
  expect(elevationFor).not.toHaveBeenCalled();expect(writeProgressiveTopology).not.toHaveBeenCalled();
  expect((await release()).sections).toHaveLength(2);
});

it("rejects empty, duplicate and unknown IDs before preparation or replacing a catalog",async()=>{
  await build(); const first=await release();
  const {catalogPath,catalog}=await discoverNetworks(recipe(),context());
  const {elevationFor}=await import("./elevation"); vi.mocked(elevationFor).mockClear();
  const verify=vi.spyOn(CoverageSourceStore.prototype,"import"); verify.mockClear();
  for(const ids of [[],[catalog.networks[0]!.id,catalog.networks[0]!.id],["network-"+"0".repeat(32)]])
    await expect(buildNetworks(catalogPath,ids,context())).rejects.toThrow(/unique|Unknown/);
  expect(await release()).toEqual(first); expect(elevationFor).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
});

it("rejects corrupt artifact bytes and receipt identity before changing the catalog",async()=>{
  await build();const first=await release();
  const receiptFile=path.join(root,"stage/networks",(await readdir(path.join(root,"stage/networks")))[0]!);
  const original=await readFile(receiptFile,"utf8"),receipt=JSON.parse(original);
  receipt.release.id="forged-identity";await writeFile(receiptFile,JSON.stringify(receipt));
  await expect(build()).rejects.toThrow("checkpoint identity");
  await writeFile(receiptFile,original);
  await writeFile(path.join(root,"release",first.artifacts[0]!.path),"corrupt");
  await expect(build()).rejects.toThrow("checkpoint failed");
  expect(await release()).toEqual(first);await expectNoScratch();
});

it("invalidates artifacts and metrics when their algorithm changes",async()=>{
  await build();const before=await release();
  algorithms.metricVersion="changed-metrics-v2";
  const {elevationFor}=await import("./elevation");vi.mocked(elevationFor).mockClear();
  await build();
  expect((await release()).artifacts[0]!.graphId).not.toBe(before.artifacts[0]!.graphId);
  expect(elevationFor).toHaveBeenCalledOnce();
});

it("a changed DEM invalidates only the network using that product",async()=>{
  const {elevationFor,describeCanonicalElevation}=await import("./elevation");
  const base=await elevationFor({id:"fixture",geometry:rectangle([-122,47,-121,48]),status:"pending"},"","",true);
  let changed=false;
  const descriptor=(geometry:Parameters<typeof describeCanonicalElevation>[0])=>{
    const east=areaBounds(geometry)[0] > -121.2,version=east&&changed?"new":"old";
    return {source:{...source,id:`dem-${east?"b":"a"}-${version}`},productFingerprint:`dem-${east?"b":"a"}-${version}`};
  };
  vi.mocked(describeCanonicalElevation).mockImplementation(async geometry=>descriptor(geometry));
  vi.mocked(elevationFor).mockImplementation(async unit=>({...base,...descriptor(unit.geometry)}));
  await build("all");const before=await release();changed=true;
  vi.mocked(elevationFor).mockClear();
  await build("all");const after=await release();
  expect(elevationFor).toHaveBeenCalledTimes(1);
  expect(after.artifacts.filter(item=>before.artifacts.some(old=>old.id===item.id))).toHaveLength(1);
});

it("a newly mapped identity connector replaces two networks with one",async()=>{
  await build("all");const before=await release();
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,contentHash:`sha256:${"2".repeat(64)}`});
  fixtureLines.push("w301 Thighway=path,foot=yes Nn2,n11");
  const updated=recipe(); updated.sources[0]!.sha256=`sha256:${"2".repeat(64)}`;
  await build("all",context(),updated);const after=await release();
  expect(before.sections).toHaveLength(2);expect(after.sections).toHaveLength(1);
  expect(before.sections.some(section=>section.id===after.sections[0]!.id)).toBe(false);
  expect((await pieces())[0]!.edges).toHaveLength(14);
  for(const artifact of before.artifacts)expect((await stat(path.join(root,"release",artifact.path))).size).toBe(artifact.compressedBytes);
});

it("publishes West Cady, Pilchuck, and the formerly cut road approach",async()=>{
  fixtureLines=(await readFile("data/fixtures/source/osm/coverage-regressions.opl","utf8")).trim().split("\n");
  await build("all");
  const published=(await pieces()).flatMap(piece=>piece.edges);
  for(const id of [372537133,951045864,951045865,37583693,218617733])expect(published.some(row=>String(row.id).startsWith(`osm-way-${id}:`))).toBe(true);
},30_000);

it("rejects a mismatched source digest and stale restriction inputs",async()=>{
  const {catalogPath,catalog}=await discoverNetworks({...recipe(),reviewedRegionIds:["missing-fixture-region"]},context());
  const access=await import("@/lib/data/curated-access");
  vi.spyOn(access,"readCuratedAccessFile").mockResolvedValue({snapshot:{...source,id:"review"},restrictions:[{externalId:"way/999",accessState:"closed",reason:"reviewed closure",review:{reviewedAt:source.retrievedAt,reviewer:"fixture"}}]});
  await expect(buildNetworks(catalogPath,[catalog.networks[0]!.id],context())).rejects.toThrow("Discovery inputs changed");
  const {readPinnedOsmSnapshot}=await import("@/lib/data/osm/source");
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({...source,contentHash:`sha256:${"2".repeat(64)}`});
  await expect(buildNetworks(catalogPath,[catalog.networks[0]!.id],context())).rejects.toThrow("Pinned source hash differs");
});

it("reads independently prepared networks through the installed graph reader",async()=>{
  await build("all");
  const catalog=await release(),artifacts=[];
  for(const artifact of catalog.artifacts){const file=path.join(root,`${artifact.id}.sqlite`);await writeFile(file,gunzipSync(await readFile(path.join(root,"release",artifact.path))));artifacts.push({path:file,geometry:artifact.geometry,graphId:artifact.graphId});}
  const repository=new PreparedGraphRepository({releaseId:catalog.id,installationId:"test",coverage:catalog.geometry,artifacts});
  try{
    const trails=[];for await(const trail of repository.iterateMapTrails({bbox:[-122,47,-121,48],includeUncertainAccess:true}))trails.push(trail);
    expect(trails).toHaveLength(6);expect(new Set(trails.map(trail=>trail.physicalEdgeKey)).size).toBe(6);
    const reachable=await repository.getReachableGraph({startNodeId:"osm-node-1",startCoordinates:[-121.26,47.51],maximumDistanceMeters:20000,maximumDirectedEdges:100,includeUncertainAccess:true,coverage:catalog.geometry});
    expect(reachable.graph.edges).toHaveLength(6);
    expect(reachable.graph.edges.every(edge=>edge.id.startsWith("osm-way-101:"))).toBe(true);
  }finally{repository.close();}
});

it("retains complete way context at a source boundary while publishing only supported segments",async()=>{
  fixtureLines=["n1 T x-121.26 y47.51","n2 T x-121.24 y47.51","n3 T x-120.9 y47.52","w101 Thighway=path,foot=yes Nn1,n2,n3"];
  await build();
  expect((await release()).sections[0]!.network?.sourceBoundaryLimited).toBe(true);
  expect((await pieces())[0]!.edges).toHaveLength(2);
});

it("retains unsupported building context disclosures when reusing a network",async()=>{
  fixtureLines.push("r30 Ttype=multipolygon,building=yes Mw999@outer");
  await build();const before=await release();
  expect(before.limitations.some(message=>message.includes("1 unsupported building relations"))).toBe(true);
  await build();expect((await release()).limitations).toEqual(before.limitations);
});

it("discovery inventories all networks without elevation, topology or publication and reopens without rediscovery",async()=>{
  const {elevationFor,describeCanonicalElevation}=await import("./elevation");
  const {writeProgressiveTopology}=await import("@/lib/data/progressive/topology");
  const scan=vi.spyOn(NetworkInventory.prototype,"discover");
  const official=vi.spyOn(await import("@/lib/data/official-trails/source"),"readOfficialTrailSourceConfig");
  const named=vi.spyOn(await import("./named-areas"),"preparedNamedAreas");
  const first=await discoverNetworks(recipe(),context());
  expect(first.catalog.networks).toHaveLength(2);
  expect(vi.mocked(filteredSourceLines).mock.calls.map(call => call[2].kind)).toEqual(["trails"]);
  expect(official).not.toHaveBeenCalled();expect(named).not.toHaveBeenCalled();
  expect(first.catalog.networks.every(network=>network.cycleRank===1&&network.lengthMeters>0)).toBe(true);
  expect(elevationFor).not.toHaveBeenCalled(); expect(describeCanonicalElevation).not.toHaveBeenCalled(); expect(writeProgressiveTopology).not.toHaveBeenCalled();
  await expect(stat(path.join(root,"release"))).rejects.toMatchObject({code:"ENOENT"});
  const importer=vi.spyOn(CoverageSourceStore.prototype,"import");importer.mockClear();
  expect(await discoverNetworks(recipe(),context())).toEqual(first);
  expect(importer).not.toHaveBeenCalled();expect(scan).toHaveBeenCalledOnce();
  await buildNetworks(first.catalogPath,[first.catalog.networks[0]!.id],context());
  expect(scan).toHaveBeenCalledOnce();
  expect(vi.mocked(filteredSourceLines).mock.calls.map(call => call[2])).toEqual([
    {kind:"trails"}, {kind:"context",geometry:first.catalog.networks[0]!.geometry},
  ]);
});
it("rejects tampered catalog metadata and inventory bytes before source or DEM work",async()=>{
  const {catalogPath,catalog}=await discoverNetworks(recipe(),context());
  const original=await readFile(catalogPath,"utf8");
  await writeFile(catalogPath,JSON.stringify({...catalog,networks:[{...catalog.networks[0]!,lengthMeters:0}]}));
  await expect(buildNetworks(catalogPath,[catalog.networks[0]!.id],context())).rejects.toThrow("identity failed");
  await writeFile(catalogPath,original);await writeFile(path.join(path.dirname(catalogPath),"inventory.sqlite"),"corrupt");
  await expect(buildNetworks(catalogPath,[catalog.networks[0]!.id],context())).rejects.toThrow("inventory failed");
  await expect(discoverNetworks(recipe(),context())).rejects.toThrow("inventory failed");
});
it("cancelled discovery removes temporary inventory and never activates partial discovery",async()=>{
  const cancelled=context();cancelled.report=async update=>{if(update.stage?.startsWith("Discovering"))throw new Error("cancelled");};
  await expect(discoverNetworks(recipe(),cancelled)).rejects.toThrow("cancelled");
  expect(await readdir(path.join(root,"stage/discovery"))).toEqual([]);
  expect((await discoverNetworks(recipe(),context())).catalog.networks).toHaveLength(2);
});

it("missing persisted inventory fails before restarting an expensive source import",async()=>{
  const {catalogPath}=await discoverNetworks(recipe(),context());
  await rm(path.join(path.dirname(catalogPath),"inventory.sqlite"));
  const importer=vi.spyOn(CoverageSourceStore.prototype,"import");importer.mockClear();
  await expect(discoverNetworks(recipe(),context())).rejects.toMatchObject({code:"ENOENT"});
  expect(importer).not.toHaveBeenCalled();
});
it("does not silently reuse an embedded recipe with different build settings",async()=>{
  const first=await discoverNetworks(recipe(),context());
  const input={...recipe(),limitations:["Reviewed source limitation"],memoryLimitMiB:2048};
  const second=await discoverNetworks(input,context());
  expect(second.catalogPath).not.toBe(first.catalogPath);
  expect(second.catalog.recipe).toEqual(input);
  expect(second.catalog.networks.map(network=>network.id)).toEqual(first.catalog.networks.map(network=>network.id));
});
