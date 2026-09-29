import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { listCoverageRegions, readCoverageRegion } from "./regions";
import { planCoverageRegion } from "./plan";
import { contentId, intersectCoverage, subtractCoverage, unionCoverage } from "./geometry";

vi.mock("node:fs/promises", async original => {
  const actual=await original<typeof import("node:fs/promises")>();
  return {...actual,readFile:vi.fn(actual.readFile)};
});
type Region=Awaited<ReturnType<typeof readCoverageRegion>>;
type Catalog={schemaVersion:number;startLimitPath:string;regions:Array<{id:string;rangeIds:string[];boundaryPath?:string;approaches:NonNullable<Region["reviewedApproaches"]>}>};
type Ranges={properties:{source:{id:string};archiveSha256:string;derivation:{missingBroadLeafIds:string[];washingtonScope:Array<{path:string;sha256:string}>}};features:Array<{properties:{id:string;name:string;ancestry:string[]};geometry:AreaGeometry}>};
let catalog:Catalog,ranges:Ranges,regions:Map<string,Region>;
beforeAll(async()=>{
  catalog=JSON.parse(await readFile(path.resolve("data/coverage/regions/catalog.json"),"utf8"));
  ranges=JSON.parse(await readFile(path.resolve("data/coverage/mountain-ranges.geojson"),"utf8"));
  regions=new Map(await Promise.all(catalog.regions.map(async({id})=>[id,await readCoverageRegion(id)] as const)));
});

it("pins named Standard leaves, ancestry and the actual Washington authoring scope",async()=>{
  expect(ranges.properties.source.id).toBe("gmba-standard-v2");
  expect(ranges.properties.archiveSha256).toBe("91b7a37e4331cea01fb8938d535d0fbfcec8aae4173e4b073e46e2896b74f198");
  expect(ranges.features).toHaveLength(127);
  expect(ranges.properties.derivation.missingBroadLeafIds).toEqual(["16221","17034","17156"]);
  for(const source of ranges.properties.derivation.washingtonScope) {
    expect(createHash("sha256").update(await readFile(path.resolve(source.path))).digest("hex")).toBe(source.sha256);
  }
  const stuart=ranges.features.find(feature=>feature.properties.id==="17043")!;
  expect(stuart.properties.name).toBe("Stuart Range");
  expect(stuart.properties.ancestry).toContain("17039"); // Wenatchee Mountains is included, not excluded.
  expect(catalog.regions.find(region=>region.id==="central-cascades")!.rangeIds).toContain("17043");
  for(const region of regions.values()) expect(region.sources![0]).toMatchObject({
    id:"gmba-standard-v2",version:"2.0",license:"CC-BY-4.0",contentHash:`sha256:${contentId(ranges)}`,
  });
});

it("plans all sixteen cores offline with supported route buffers and explicit provenance",async()=>{
  expect((await listCoverageRegions()).map(entry=>entry.id).sort()).toEqual([
    "central-cascades","henry-coe","monterey-carmel","north-cascades","olympic-peninsula",
    "rainier-goat-rocks","santa-cruz-mountains","southern-east-bay","southwest-cascades",
    "blue-mountains","columbia-basin","north-puget","northeast-washington","south-puget","spokane-palouse","willapa-hills",
  ].sort());
  for(const [id,region] of regions) {
    const plan=planCoverageRegion(region);
    expect(subtractCoverage(plan.geometry,unionCoverage(region.recipe.sources.map(source=>source.geometry))),id).toBeNull();
    for(const exclusion of region.recipe.exclusions) expect(intersectCoverage(plan.geometry,exclusion.geometry),`${id}: ${exclusion.id}`).toBeNull();
    expect(region.sources?.map(source=>source.id)).toEqual(["gmba-standard-v2",`region-boundary-${id}`,`region-approaches-${id}`]);
    for(const source of region.sources??[]) expect(source.contentHash,id).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
},15000);

it("keeps representative mountain starts while excluding lowland cities from Central",()=>{
  const central=regions.get("central-cascades")!;
  for(const point of [[-121.3366962,48.0937555],[-121.0756526,47.8662242],[-120.8207727,47.5277884]] as [number,number][])
    expect(coordinateIsInsideArea(point,central.geometry),String(point)).toBe(true); // Lost Creek, Heather, Stuart Lake
  for(const point of [[-122.1252,48.1987],[-122.334,48.4212],[-122.33,47.61]] as [number,number][])
    expect(coordinateIsInsideArea(point,central.geometry),String(point)).toBe(false); // Arlington, Mount Vernon, Seattle
  expect(central.replaces).toBeUndefined();
  expect(central.aliases).toEqual(expect.arrayContaining(["Glacier Peak","Glacier Peak Wilderness","Henry M. Jackson Wilderness"]));
});

it("retains reviewed approaches as audit anchors without adding their neighborhoods to the core",async()=>{
  const central=regions.get("central-cascades")!;
  expect(central.reviewedApproaches).toHaveLength(28);
  expect(central.reviewedApproaches!.find(point=>point.id==="6304.005511")?.radiusMeters).toBe(600);
  expect(central.reviewedApproaches!.filter(point=>point.id==="5278010416")).toHaveLength(1);
  expect(central.reviewedApproaches!.some(point=>point.id==="6300.005511")).toBe(false);
  const baseline=JSON.parse(await readFile(path.resolve("data/fixtures/coverage/central-cascades-baseline.json"),"utf8"));
  for(const previous of baseline.regions) for(const expected of previous.approaches)
    expect(central.reviewedApproaches).toContainEqual({id:expected.id,name:expected.name,coordinates:expected.coordinates,radiusMeters:expected.radiusMeters});
  const olympic=regions.get("olympic-peninsula")!,ozette:[number,number]=[-124.66889,48.15519];
  expect(coordinateIsInsideArea(ozette,olympic.geometry)).toBe(false);
  expect(coordinateIsInsideArea(ozette,olympic.startLimitGeometry!)).toBe(true);
  const changed=structuredClone(catalog);
  changed.regions.find(region=>region.id==="central-cascades")!.approaches=[];
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  const withoutAnchors=await readCoverageRegion("central-cascades");
  expect(withoutAnchors.geometry).toEqual(central.geometry);
  expect(withoutAnchors.startLimitGeometry!).toEqual(central.startLimitGeometry!);
  expect(withoutAnchors.sources![2]!.contentHash).not.toBe(central.sources![2]!.contentHash);
});

it("limits Washington starts to Washington while route support can extend into Oregon",()=>{
  const southwest=regions.get("southwest-cascades")!,oregon:[number,number]=[-122,45.5];
  expect(coordinateIsInsideArea(oregon,southwest.geometry)).toBe(false);
  expect(coordinateIsInsideArea(oregon,southwest.startLimitGeometry!)).toBe(false);
  expect(coordinateIsInsideArea(oregon,planCoverageRegion(southwest).geometry)).toBe(true);
  expect(coordinateIsInsideArea([-116.7,47.7],regions.get("northeast-washington")!.startLimitGeometry!)).toBe(false); // Idaho
  const north=planCoverageRegion(regions.get("north-cascades")!);
  expect(coordinateIsInsideArea([-121.4077738,48.9998624],north.geometry)).toBe(true); // US Chilliwack routing support
  expect(coordinateIsInsideArea([-121.7736891,48.99766],north.geometry)).toBe(false); // Canada
  expect(coordinateIsInsideArea([-123.36,48.43],regions.get("olympic-peninsula")!.startLimitGeometry!)).toBe(false); // Victoria
});

it("keeps exact California product caps while using only Standard core inside them",()=>{
  const fingerprints={
    "santa-cruz-mountains":"7bfef8e191bc4b2800054e24dd583778db141e04fe2f7f4926d485f362e49d69",
    "southern-east-bay":"327daa394bce0cf8526d13bf45ca2da056db97bb493767cca296cb0589a0edb8",
    "monterey-carmel":"a18f24c1c6edf7bd4c4a4b383103c90768b3dbda7b3c36d286e099805837b834",
    "henry-coe":"d5396aa3309b3637b13b7731bb28b99f7181854a8ff296b62bb3e6ae7a8d4a98",
  };
  for(const [id,hash] of Object.entries(fingerprints)) {
    const region=regions.get(id)!;
    expect(contentId(region.startLimitGeometry!),id).toBe(hash);
    expect(subtractCoverage(region.geometry,region.startLimitGeometry!),id).toBeNull();
    expect(coordinateIsInsideArea([-122.7,38],region.geometry),id).toBe(false); // no North Bay expansion
    expect(coordinateIsInsideArea([-122.7,38],region.startLimitGeometry!),id).toBe(false);
  }
  const coe=regions.get("henry-coe")!;
  expect(coordinateIsInsideArea([-121.5458297,37.1878465],coe.geometry)).toBe(true);
  expect(coordinateIsInsideArea([-121.577518,37.096626],coe.geometry)).toBe(false); // Harvey Bear approach stays outside core
  expect(coordinateIsInsideArea([-121.577518,37.096626],coe.startLimitGeometry!)).toBe(true);
});

it.each([
  {patch:{rangeIds:[]},reason:"empty selection"},
  {patch:{rangeIds:["17043","17043"]},reason:"duplicate leaf"},
  {patch:{rangeIds:["../17043"]},reason:"invalid leaf ID"},
  {patch:{boundaryPath:"central-cascades-boundary.geojson"},reason:"Washington boundary override"},
  {patch:{replaces:["glacier-peak"]},reason:"obsolete replacement promise"},
])("rejects $reason",async({patch})=>{
  const changed=structuredClone(catalog);
  Object.assign(changed.regions.find(region=>region.id==="central-cascades")!,patch);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(listCoverageRegions()).rejects.toThrow();
});

it("rejects missing ranges instead of falling back to a broad outline",async()=>{
  const changed=structuredClone(catalog);
  changed.regions.find(region=>region.id==="central-cascades")!.rangeIds=["999999"];
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(readCoverageRegion("central-cascades")).rejects.toThrow("Unknown Standard mountain range 999999");
});
