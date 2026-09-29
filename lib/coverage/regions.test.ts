import { expect, it } from "vitest";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { listCoverageRegions, readCoverageRegion } from "./regions";
import { planCoverageRegion } from "./plan";
import { intersectCoverage, subtractCoverage, unionCoverage } from "./geometry";

it("plans every restored area offline with explicit provenance and a completely covered route buffer",async()=>{
  const entries=await listCoverageRegions();
  expect(entries.map(entry=>entry.id).sort()).toEqual([
    "central-cascades","glacier-peak","henry-coe","henry-m-jackson","monterey-carmel",
    "north-cascades","olympic-peninsula","rainier-goat-rocks","santa-cruz-mountains",
    "southern-east-bay","southwest-cascades",
  ]);
  for(const {id} of entries) {
    const region=await readCoverageRegion(id),plan=planCoverageRegion(region);
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

it("resolves a pinned named footprint with real approaches and no live services",async()=>{
  expect(await listCoverageRegions()).toContainEqual({id:"glacier-peak",name:"Glacier Peak area"});
  const region=await readCoverageRegion("glacier-peak");
  const plan=planCoverageRegion(region);
  expect(plan).toMatchObject({id:region.id,name:region.name,maximumRouteMiles:40,bufferMiles:25});
  for(const point of [[-120.6502147,48.0246058],[-120.8350148,48.0832058],[-121.2882148,48.0579058]] as [number,number][]) {
    expect(coordinateIsInsideArea(point,plan.startGeometry)).toBe(true);
    expect(coordinateIsInsideArea(point,plan.geometry)).toBe(true);
  }
  expect(coordinateIsInsideArea([-122.33,47.61],plan.startGeometry)).toBe(false);
  expect(region.sources).toHaveLength(2);
  // Retain the mapped Lost Creek Ridge entrance outside the legal wilderness.
  expect(coordinateIsInsideArea([-121.3366962,48.0937555],plan.startGeometry)).toBe(true);
  await expect(readCoverageRegion("../washington")).rejects.toThrow("Unknown region");
});

it("plans neighboring areas with a shared approach and distinct eligible starts",async()=>{
  expect(await listCoverageRegions()).toContainEqual({id:"henry-m-jackson",name:"Henry M. Jackson area"});
  const glacier=await readCoverageRegion("glacier-peak");
  const jackson=await readCoverageRegion("henry-m-jackson");
  const first=planCoverageRegion(glacier),second=planCoverageRegion(jackson);
  // Reuse the same provider snapshot; adding an area must not require a source refresh.
  expect(jackson.recipe.sources).toEqual(glacier.recipe.sources);
  expect(second).toMatchObject({id:"henry-m-jackson",maximumRouteMiles:40,bufferMiles:25});
  const shared:[number,number]=[-121.0876148,47.9170158]; // Little Wenatchee Ford
  expect(coordinateIsInsideArea(shared,first.startGeometry)).toBe(true);
  expect(coordinateIsInsideArea(shared,second.startGeometry)).toBe(true);
  const smithbrook:[number,number]=[-121.0766597,47.8025038];
  expect(coordinateIsInsideArea(smithbrook,first.startGeometry)).toBe(false);
  expect(coordinateIsInsideArea(smithbrook,second.startGeometry)).toBe(true);
  const downey:[number,number]=[-121.2229149,48.2595058];
  expect(coordinateIsInsideArea(downey,second.startGeometry)).toBe(false);
  expect(coordinateIsInsideArea(downey,second.geometry)).toBe(true);
  // Reject the mislocated USFS Stevens Pass North record, which points to Snoqualmie.
  expect(coordinateIsInsideArea([-121.4154977,47.4284097],second.startGeometry)).toBe(false);
  // Heather's mapped parking/trail contact lies 528 m from the agency point.
  expect(coordinateIsInsideArea([-121.0756526,47.8662242],second.startGeometry)).toBe(true);
  expect(jackson.sources?.map(source=>source.id)).toEqual([
    "region-boundary-henry-m-jackson","region-approaches-henry-m-jackson",
  ]);
});
