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
