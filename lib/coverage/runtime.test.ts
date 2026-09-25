import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import { rectangle } from "./geometry";
import { plan, run } from "./runtime";

const algorithms=vi.hoisted(()=>({metricVersion:undefined as string|undefined}));
vi.mock("@/lib/data/elevation/uv-rasterio-sampler",async importOriginal=>{
  const actual=await importOriginal<typeof import("@/lib/data/elevation/uv-rasterio-sampler")>();
  return {...actual,get PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION(){return algorithms.metricVersion??actual.PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION;}};
});
vi.mock("@/lib/data/osm/source", () => ({ readOsmSourceConfig: vi.fn(), inspectPinnedOsmSnapshot: vi.fn(), readPinnedOsmSnapshot: vi.fn(), refreshPinnedOsmSnapshot: vi.fn() }));
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
  vi.stubEnv("ALPINE_RELEASE_ROOT", path.join(root,"release"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", path.join(root, "stage"));
  vi.stubEnv("ALPINE_PACK_ROOT", path.join(root, "packs"));
  vi.stubEnv("ALPINE_ROUTE_JOBS_DB", path.join(root, "absent-route-jobs.sqlite"));
  const { inspectPinnedOsmSnapshot, readPinnedOsmSnapshot } = await import("@/lib/data/osm/source");
  vi.mocked(inspectPinnedOsmSnapshot).mockResolvedValue(source);
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
it("exports a coherent graph once, preserving every source edge and boundary endpoints across sections",async()=>{
  const updates:string[]=[];
  await run(await request(-121.27,-121.23),{...context(),report:async update=>{updates.push(update.stage??"");}});
  expect(updates.filter(stage=>stage==="Coherent release exported")).toHaveLength(1);
  const sections=await pieces();expect(sections).toHaveLength(2);
  const edges=new Map(sections.flatMap(piece=>piece.edges.map(edge=>[edge.id,edge])));
  expect(edges.size).toBe(6);
  for(const piece of sections) for(const edge of piece.edges) {
    expect(piece.nodes.some(node=>node.id===edge.from_node)).toBe(true);
    expect(piece.nodes.some(node=>node.id===edge.to_node)).toBe(true);
    expect(edge).toEqual(edges.get(edge.id));
  }
  expect(sections[0]!.edges.some(edge=>sections[1]!.edges.some(other=>other.id===edge.id))).toBe(true);
  expect((await release()).graphSchemaVersion).toBe("7");
});
it("resumes interrupted metrics without an intermediate release and exports deterministic bytes",async()=>{
  const {elevationFor}=await import("./elevation");
  const sample=vi.fn(async(coordinates:ReadonlyArray<readonly[number,number]>)=>coordinates.map(()=>100));
  const elevation=await elevationFor((await request(-121.27,-121.23)).units[0]!,"","",true);
  vi.mocked(elevationFor).mockResolvedValue({...elevation,sampler:{algorithmVersion:"fixture",sample}});
  const interrupted=context();interrupted.report=async update=>{if(update.stage?.startsWith("Prepared ")) throw new Error("interrupted");};
  await expect(run(await request(-121.27,-121.23),interrupted)).rejects.toThrow("interrupted");
  await expect(release()).rejects.toThrow();
  await run(await request(-121.27,-121.23),context());
  const first=await release();sample.mockClear();
  await run(await request(-121.27,-121.23),context());
  expect(await release()).toEqual(first);expect(sample).not.toHaveBeenCalled();
});
it("rejects tampered staging receipts and preserves the previous release",async()=>{
  await run(await request(-121.27,-121.23),context()); const prior=await release();
  const file=(await readdir(path.join(root,"stage"))).find(name=>name.startsWith("graph-")&&name.endsWith(".sqlite")&&!name.includes("complete"))!;
  const db=new DatabaseSync(path.join(root,"stage",file));try {db.exec("DELETE FROM edges WHERE id=(SELECT id FROM edges LIMIT 1)");} finally {db.close();}
  await expect(run(await request(-121.27,-121.23),context())).rejects.toThrow("checkpoint");
  expect(await release()).toEqual(prior);
});
it("invalidates the coherent release when metric algorithms change",async()=>{
  await run(await request(-121.27,-121.23),context());const prior=await release();
  algorithms.metricVersion="fixture-v2";
  await run(await request(-121.27,-121.23),context());expect((await release()).id).not.toBe(prior.id);
});
it("supports empty water sections without acquiring elevation",async()=>{
  const {elevationFor}=await import("./elevation");vi.mocked(elevationFor).mockClear();
  await run(await request(-121.8,-121.7),context());expect(elevationFor).not.toHaveBeenCalled();
  expect((await pieces()).every(piece=>piece.edges.length===0)).toBe(true);
});

it("publishes West Cady, wholly omitted Pilchuck, and the formerly cut road approach from the broader inventory", async () => {
  const fixture = (await readFile("data/fixtures/source/osm/coverage-regressions.opl","utf8")).trim().split("\n");
  vi.mocked(CoverageSourceStore.prototype.import).mockImplementation(function (this:CoverageSourceStore,check) {
    async function* lines() {yield* fixture;}
    return importSource.call(this,check,{lines:lines()});
  });
  await run(await plan({collectionIds:[],geometry:rectangle([-121.9,47.8,-121.1,48.2]),memoryLimitMiB:4096,offline:true}),context());
  const published = (await pieces()).flatMap(piece=>piece.edges);
  for (const id of [372537133,951045864,951045865,37583693,218617733])
    expect(published.some(row=>String(row.id).startsWith(`osm-way-${id}:`))).toBe(true);
},30_000);
