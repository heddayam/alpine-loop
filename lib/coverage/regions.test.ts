import { expect, it } from "vitest";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { listCoverageRegions, readCoverageRegion } from "./regions";
import { planCoverageRegion } from "./plan";

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
  expect(jackson.sources?.map(source=>source.id)).toEqual([
    "region-boundary-henry-m-jackson","region-approaches-henry-m-jackson",
  ]);
});
