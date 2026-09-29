import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { listCoverageRegions, readCoverageRegion } from "./regions";
import { planCoverageRegion } from "./plan";
import { intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import type { CoverageRegion } from "./types";

vi.mock("node:fs/promises", async original => {
  const actual=await original<typeof import("node:fs/promises")>();
  return {...actual,readFile:vi.fn(actual.readFile)};
});
type Approach=NonNullable<CoverageRegion["reviewedApproaches"]>[number];
type BaselineRegion={id:string;boundary:{geometry:AreaGeometry};approaches:Array<Approach & {neighborhood:AreaGeometry}>};
let baseline:BaselineRegion[],central:CoverageRegion,catalog: {regions:Array<{id:string;replaces?:string[];approaches:Array<{id:string}>}>};
beforeAll(async()=>{
  baseline=JSON.parse(await readFile(path.resolve("data/fixtures/coverage/central-cascades-baseline.json"),"utf8")).regions;
  catalog=JSON.parse(await readFile(path.resolve("data/coverage/regions/catalog.json"),"utf8"));
  central=await readCoverageRegion("central-cascades");
});
const footprint=(region:BaselineRegion)=>unionCoverage([region.boundary.geometry,...region.approaches.map(point=>point.neighborhood)]);
// Polygon intersections can differ in their last floating-point bits. Compare
// aggregate residual area, not vertices or envelopes; 1e-14 square degrees is
// under 0.0001 m² here. Translate each ring before shoelace accumulation.
const AREA_TOLERANCE=1e-14;
function omittedArea(expected:AreaGeometry,actual:AreaGeometry):number {
  const missing=subtractCoverage(expected,actual);
  if(!missing) return 0;
  const polygons=missing.type==="Polygon"?[missing.coordinates]:missing.coordinates;
  return polygons.reduce((total,polygon)=>total+polygon.reduce((area,ring,index)=>{
    const [x,y]=ring[0]!;
    let signed=0;
    for(let i=1;i<ring.length;i++) signed+=(ring[i-1]![0]-x)*(ring[i]![1]-y)-(ring[i]![0]-x)*(ring[i-1]![1]-y);
    return area+(index===0?1:-1)*Math.abs(signed/2);
  },0),0);
}
function omittedApproaches(region:CoverageRegion):string[] {
  return baseline.flatMap(previous=>previous.approaches.filter(expected=>!region.reviewedApproaches?.some(actual=>
    actual.id===expected.id && actual.name===expected.name && actual.radiusMeters===expected.radiusMeters &&
    actual.coordinates.every((coordinate,index)=>coordinate===expected.coordinates[index])
  )).map(point=>point.id));
}

it("plans the nine consolidated areas offline with explicit provenance and a completely covered route buffer",async()=>{
  const entries=await listCoverageRegions();
  expect(entries.map(entry=>entry.id).sort()).toEqual([
    "central-cascades","henry-coe","monterey-carmel","north-cascades","olympic-peninsula",
    "rainier-goat-rocks","santa-cruz-mountains","southern-east-bay","southwest-cascades",
  ]);
  for(const {id} of entries) {
    const region=id===central.id?central:await readCoverageRegion(id),plan=planCoverageRegion(region);
    expect(subtractCoverage(plan.geometry,unionCoverage(region.recipe.sources.map(source=>source.geometry))),id).toBeNull();
    for(const exclusion of region.recipe.exclusions) expect(intersectCoverage(plan.geometry,exclusion.geometry),`${id}: ${exclusion.id}`).toBeNull();
    expect(region.reviewedApproaches?.length,id).toBeGreaterThan(0);
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
    expect(omittedArea(expected,central.geometry),previous.id).toBeLessThan(AREA_TOLERANCE);
    expect(omittedArea(expected,plan.startGeometry),`${previous.id} after support/exclusions`).toBeLessThan(AREA_TOLERANCE);
    for(const point of previous.approaches) expect(subtractCoverage(point.neighborhood,plan.startGeometry),point.id).toBeNull();
  }
  expect(coordinateIsInsideArea([-122.33,47.61],plan.startGeometry)).toBe(false);
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
  for(const pilot of baseline.slice(1)) expect(omittedArea(footprint(pilot),incomplete),pilot.id).toBeGreaterThan(AREA_TOLERANCE);
});

it("detects an interior hole even when all original wilderness boundary vertices remain covered",()=>{
  const glacier=baseline.find(region=>region.id==="glacier-peak")!;
  const hole=rectangle([-121.11301,48.11199,-121.11299,48.11201]);
  expect(subtractCoverage(hole,glacier.boundary.geometry)).toBeNull();
  const damaged=subtractCoverage(central.geometry,hole)!;
  const rings=glacier.boundary.geometry.type==="Polygon"?glacier.boundary.geometry.coordinates:glacier.boundary.geometry.coordinates.flat();
  expect(rings.flat().every(point=>coordinateIsInsideArea(point,damaged))).toBe(true);
  expect(omittedArea(footprint(glacier),damaged)).toBeGreaterThan(AREA_TOLERANCE);
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
