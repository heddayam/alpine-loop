import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { listCoverageRegions, readCoverageRegion } from "./regions";
import { planCoverageRegion } from "./plan";
import { containsCoverage } from "@/lib/graph/coverage-containment";
import { contentId, intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import type { CoverageRegion } from "./types";

vi.mock("node:fs/promises", async original => {
  const actual=await original<typeof import("node:fs/promises")>();
  return {...actual,readFile:vi.fn(actual.readFile)};
});
type Approach=NonNullable<CoverageRegion["reviewedApproaches"]>[number];
type BaselineRegion={id:string;boundary:{geometry:AreaGeometry};approaches:Array<Approach & {neighborhood:AreaGeometry}>};
let baseline:BaselineRegion[],central:CoverageRegion,catalog: {regions:Array<{id:string;replaces?:string[];territory?:{id:string;unitIds:string[]};boundaryPath?:string;approaches:Array<{id:string}>}>};
beforeAll(async()=>{
  baseline=JSON.parse(await readFile(path.resolve("data/fixtures/coverage/central-cascades-baseline.json"),"utf8")).regions;
  catalog=JSON.parse(await readFile(path.resolve("data/coverage/regions/catalog.json"),"utf8"));
  central=await readCoverageRegion("central-cascades");
});
const footprint=(region:BaselineRegion)=>unionCoverage([region.boundary.geometry,...region.approaches.map(point=>point.neighborhood)]);
function omittedApproaches(region:CoverageRegion):string[] {
  return baseline.flatMap(previous=>previous.approaches.filter(expected=>!region.reviewedApproaches?.some(actual=>
    actual.id===expected.id && actual.name===expected.name && actual.radiusMeters===expected.radiusMeters &&
    actual.coordinates.every((coordinate,index)=>coordinate===expected.coordinates[index])
  )).map(point=>point.id));
}

it("plans all sixteen areas offline with explicit provenance and a completely covered route buffer",async()=>{
  const entries=await listCoverageRegions();
  expect(entries.map(entry=>entry.id).sort()).toEqual([
    "central-cascades","henry-coe","monterey-carmel","north-cascades","olympic-peninsula",
    "rainier-goat-rocks","santa-cruz-mountains","southern-east-bay","southwest-cascades",
    "blue-mountains","columbia-basin","north-puget","northeast-washington","south-puget","spokane-palouse","willapa-hills",
  ].sort());
  for(const {id} of entries) {
    const region=id===central.id?central:await readCoverageRegion(id),plan=planCoverageRegion(region);
    expect(subtractCoverage(plan.geometry,unionCoverage(region.recipe.sources.map(source=>source.geometry))),id).toBeNull();
    for(const exclusion of region.recipe.exclusions) expect(intersectCoverage(plan.geometry,exclusion.geometry),`${id}: ${exclusion.id}`).toBeNull();
    expect(region.sources?.map(source=>source.id)).toEqual([`region-boundary-${id}`,`region-approaches-${id}`]);
    for(const source of region.sources??[]) {
      expect(source.license.length,id).toBeGreaterThan(0);
      expect(source.contentHash,id).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  }
  const california=await readCoverageRegion("santa-cruz-mountains");
  expect(california.sources?.[0]?.authority).not.toBe("USDA Forest Service");
  expect(california.recipe.reviewedRegionIds.slice().sort()).toEqual(["henry-coe","monterey-carmel","santa-cruz-mountains","southern-east-bay"]);
});

it("preserves US trail coverage at the northern border and extends Southwest support into Oregon",async()=>{
  const north=planCoverageRegion(await readCoverageRegion("north-cascades"));
  expect(coordinateIsInsideArea([-121.4077738,48.9998624],north.geometry)).toBe(true);
  expect(coordinateIsInsideArea([-121.7736891,48.99766],north.geometry)).toBe(false);
  const olympic=planCoverageRegion(await readCoverageRegion("olympic-peninsula"));
  expect(coordinateIsInsideArea([-123.36,48.43],olympic.geometry)).toBe(false); // Victoria, Canada
  expect(coordinateIsInsideArea([-124.66889,48.15519],olympic.startGeometry)).toBe(true); // Ozette
  const southwest=planCoverageRegion(await readCoverageRegion("southwest-cascades"));
  expect(coordinateIsInsideArea([-122,45.5],southwest.geometry)).toBe(true); // Oregon buffer, not a new start area
  expect(coordinateIsInsideArea([-122,45.5],southwest.startGeometry)).toBe(false);
});

it("preserves every point of all three original start footprints, including the approach neighborhoods",()=>{
  const plan=planCoverageRegion(central);
  expect(plan).toMatchObject({id:"central-cascades",name:"Central Cascades",maximumRouteMiles:40,bufferMiles:25});
  for(const previous of baseline) {
    const expected=footprint(previous);
    expect(containsCoverage(central.geometry,expected),previous.id).toBe(true);
    expect(containsCoverage(plan.startGeometry,expected),`${previous.id} after support/exclusions`).toBe(true);
    for(const point of previous.approaches) expect(subtractCoverage(point.neighborhood,plan.startGeometry),point.id).toBeNull();
  }
  // Seattle is within the start territory; buildings, not this boundary, exclude dense starts.
  expect(coordinateIsInsideArea([-122.33,47.61],plan.startGeometry)).toBe(true);
});

it("retains all reviewed approaches and radii, deduplicating only the shared record",()=>{
  expect(omittedApproaches(central)).toEqual([]);
  expect(central.reviewedApproaches).toHaveLength(28);
  expect(central.reviewedApproaches?.filter(point=>point.id==="5278010416")).toHaveLength(1); // Little Wenatchee Ford
  // Nearby OSM-era and USFS checkpoints are distinct review evidence, not duplicates.
  const whiteRiver=central.reviewedApproaches!.filter(point=>["historical-east-glacier-peak-white-river","6307.005511"].includes(point.id));
  expect(whiteRiver).toHaveLength(2);
  expect(whiteRiver[0]!.coordinates).not.toEqual(whiteRiver[1]!.coordinates);
  expect(central.reviewedApproaches!.find(point=>point.id==="6304.005511")?.radiusMeters).toBe(600);
  expect(coordinateIsInsideArea([-121.3366962,48.0937555],central.geometry)).toBe(true); // Lost Creek mapped entrance
  expect(coordinateIsInsideArea([-121.0756526,47.8662242],central.geometry)).toBe(true); // Heather parking/trail contact
  expect(central.reviewedApproaches?.some(point=>point.id==="6300.005511")).toBe(false); // Mislocated agency record
});

it("detects a removed approach even if the retained boundary still covers its location",async()=>{
  const changed=structuredClone(catalog);
  changed.regions.find(region=>region.id==="central-cascades")!.approaches=changed.regions.find(region=>region.id==="central-cascades")!.approaches.filter(point=>point.id!=="48232");
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  expect(omittedApproaches(await readCoverageRegion("central-cascades"))).toContain("48232");
});

it("detects an omitted pilot footprint when only its approaches are added to the historical Central boundary",()=>{
  const incomplete=unionCoverage([baseline[0]!.boundary.geometry,...baseline.flatMap(region=>region.approaches.map(point=>point.neighborhood))]);
  for(const pilot of baseline.slice(1)) expect(containsCoverage(incomplete,footprint(pilot)),pilot.id).toBe(false);
});

it("detects an interior hole even when all original wilderness boundary vertices remain covered",()=>{
  const glacier=baseline.find(region=>region.id==="glacier-peak")!;
  const hole=rectangle([-121.11301,48.11199,-121.11299,48.11201]);
  expect(subtractCoverage(hole,glacier.boundary.geometry)).toBeNull();
  const damaged=subtractCoverage(central.geometry,hole)!;
  const rings=glacier.boundary.geometry.type==="Polygon"?glacier.boundary.geometry.coordinates:glacier.boundary.geometry.coordinates.flat();
  expect(rings.flat().every(point=>coordinateIsInsideArea(point,damaged))).toBe(true);
  expect(containsCoverage(damaged,footprint(glacier))).toBe(false);
});

it("exposes explicit replacements and aliases with mixed boundary/approach provenance",async()=>{
  expect(central.replaces).toEqual(["glacier-peak","henry-m-jackson"]);
  expect(central.aliases).toEqual(expect.arrayContaining(["Glacier Peak","Glacier Peak Wilderness","Henry M. Jackson","Henry M. Jackson Wilderness","Henry M Jackson Wilderness"]));
  for(const source of central.sources!) {
    expect(source.authority).toContain("OpenStreetMap contributors");
    expect(source.authority).toContain("USDA Forest Service");
    expect(source.license).toContain("ODbL");
    expect(source.license).toContain("public-domain");
  }
  expect((await readCoverageRegion("henry-coe")).replaces).toBeUndefined();
  for(const id of ["glacier-peak","henry-m-jackson","../washington"]) await expect(readCoverageRegion(id)).rejects.toThrow("Unknown region");
});

it.each([
  {replaces:["../glacier-peak"],reason:"invalid ID"},
  {replaces:["central-cascades"],reason:"self replacement"},
  {replaces:["glacier-peak","glacier-peak"],reason:"duplicate ID"},
  {replaces:[],reason:"empty declaration"},
])("rejects $reason in replacement metadata",async({replaces})=>{
  const changed=structuredClone(catalog);
  changed.regions.find(region=>region.id==="central-cascades")!.replaces=replaces;
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(listCoverageRegions()).rejects.toThrow();
});

it("assigns every one of the 39 pinned Washington counties exactly once",async()=>{
  const source=JSON.parse(await readFile(path.resolve("data/coverage/territories/washington-counties.geojson"),"utf8")) as {features:Array<{id:string;geometry:AreaGeometry}>};
  const assigned=catalog.regions.flatMap(region=>region.territory?.unitIds??[]);
  expect(source.features).toHaveLength(39);
  expect(assigned.slice().sort()).toEqual(source.features.map(feature=>feature.id).sort());
  const washington=catalog.regions.filter(region=>region.territory);
  expect(washington).toHaveLength(12);
  // Full polygon containment catches holes/interior omissions, not just missing vertices.
  for(const entry of washington){
    const region=await readCoverageRegion(entry.id);
    for(const id of entry.territory!.unitIds)
      expect(containsCoverage(region.geometry,source.features.find(feature=>feature.id===id)!.geometry),id).toBe(true);
  }
});

it.each(["unassigned","duplicate","unknown unit","unknown territory"])("rejects %s territory assignment",async kind=>{
  const changed=structuredClone(catalog),entry=changed.regions.find(region=>region.id==="north-cascades")!;
  if(kind==="unassigned")entry.territory!.unitIds.pop();
  if(kind==="duplicate")entry.territory!.unitIds.push(entry.territory!.unitIds[0]!);
  if(kind==="unknown unit")entry.territory!.unitIds.push("missing");
  if(kind==="unknown territory")entry.territory!.id="missing";
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(listCoverageRegions()).rejects.toThrow(/territory/i);
});

it("preserves the exact existing California start footprints without filling their bounding box",async()=>{
  // Pinned effective footprints before the Washington expansion, including approaches.
  const fingerprints={
    "santa-cruz-mountains":"7bfef8e191bc4b2800054e24dd583778db141e04fe2f7f4926d485f362e49d69",
    "southern-east-bay":"327daa394bce0cf8526d13bf45ca2da056db97bb493767cca296cb0589a0edb8",
    "monterey-carmel":"a18f24c1c6edf7bd4c4a4b383103c90768b3dbda7b3c36d286e099805837b834",
    "henry-coe":"d5396aa3309b3637b13b7731bb28b99f7181854a8ff296b62bb3e6ae7a8d4a98",
  };
  for(const [id,hash] of Object.entries(fingerprints)){
    const entry=catalog.regions.find(region=>region.id===id)!;
    expect(entry.territory).toBeUndefined();
    expect(entry.boundaryPath).toBe(`../../regions/${id}/boundary.geojson`);
    const region=await readCoverageRegion(id);
    expect(contentId(region.geometry),id).toBe(hash);
    expect(coordinateIsInsideArea([-122.7,38],region.geometry)).toBe(false); // no new North Bay scope
  }
});
