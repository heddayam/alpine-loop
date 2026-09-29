import { expect, it } from "vitest";
import { areaGeometryBounds } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { rectangle, subtractCoverage } from "./geometry";
import { constrainCoverage, entranceNeighborhood, expandCoveragePlan, planLocalCoverage } from "./plan";
import type { SourceRecipe } from "./recipe";

const recipe = {
  sources: [{ geometry: rectangle([-125, 45, -117, 50]) }], exclusions: [],
} as unknown as SourceRecipe;
const starts = rectangle([-121.5, 47.8, -121.4, 47.9]);

it("covers all 25-mile destinations from every corner, including close-match distance", () => {
  const plan = planLocalCoverage(recipe, starts);
  expect(plan).toMatchObject({ startGeometry: starts, maximumRouteMiles: 40, bufferMiles: 25 });
  // Independent spherical forward-geodesic oracle using the metric engine radius.
  const angularDistance = 25 * 1609.344 / 6371008.8;
  for (const [lon, lat] of starts.coordinates[0] as number[][]) {
    const phi = lat! * Math.PI / 180, lambda = lon! * Math.PI / 180;
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const bearing = degrees * Math.PI / 180;
      const destinationLat = Math.asin(Math.sin(phi) * Math.cos(angularDistance) + Math.cos(phi) * Math.sin(angularDistance) * Math.cos(bearing));
      const destinationLon = lambda + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(phi), Math.cos(angularDistance) - Math.sin(phi) * Math.sin(destinationLat));
      expect(coordinateIsInsideArea([destinationLon * 180 / Math.PI, destinationLat * 180 / Math.PI], plan.geometry)).toBe(true);
    }
  }
  expect(areaGeometryBounds(plan.geometry)[0]).toBeLessThan(-122);
});

it("rejects uncovered source boundaries and holes rather than shrinking the buffer", () => {
  expect(() => planLocalCoverage(recipe, rectangle([-124.9, 47.8, -124.8, 47.9]))).toThrow("complete 25-mile");
  const sourceWithHole = { type: "Polygon", coordinates: [
    [[-125,45],[-117,45],[-117,50],[-125,50],[-125,45]],
    [[-121.3,48],[-121.2,48],[-121.2,48.1],[-121.3,48.1],[-121.3,48]],
  ] };
  expect(() => planLocalCoverage({ ...recipe, sources: [{ ...recipe.sources[0]!, geometry: sourceWithHole as typeof starts }] }, starts)).toThrow("complete 25-mile");
});

it("supports adjoining source extents but treats explicit exclusions as hard boundaries", () => {
  const sources = [rectangle([-125,45,-121.45,50]), rectangle([-121.45,45,-117,50])].map(geometry => ({ ...recipe.sources[0]!, geometry }));
  const plan = planLocalCoverage({ ...recipe, sources, exclusions: [{id:"closed", geometry:rectangle([-121.48,47.82,-121.46,47.84])}] }, starts);
  expect(coordinateIsInsideArea([-121.47,47.83],plan.startGeometry)).toBe(false);
  expect(coordinateIsInsideArea([-121.47,47.83],plan.geometry)).toBe(false);
  expect(() => planLocalCoverage({ ...recipe, exclusions:[{id:"all",geometry:starts}] }, starts)).toThrow("No supported start");
});

it("rejects unsupported polar and antimeridian buffers and retains stable area identity", () => {
  expect(() => planLocalCoverage(recipe, rectangle([0,89.8,0.1,89.9]))).toThrow("pole");
  expect(() => planLocalCoverage(recipe, rectangle([179.8,0,179.9,0.1]))).toThrow("antimeridian");
  expect(planLocalCoverage(recipe, starts).id).toBe(planLocalCoverage({ ...recipe, sources: [...recipe.sources].reverse() }, starts).id);
});

it("clips only the declared international limit, while rejecting missing US source coverage",()=>{
  const supportedArea={name:"US side",geometry:rectangle([-130,40,-110,49])};
  const borderStarts=rectangle([-121,48.9,-120.9,49.1]);
  const usRecipe={...recipe,supportedArea,sources:[{...recipe.sources[0]!,geometry:rectangle([-125,45,-117,49])}]};
  const plan=planLocalCoverage(usRecipe,borderStarts);
  expect(coordinateIsInsideArea([-120.95,49.05],plan.startGeometry)).toBe(false);
  expect(coordinateIsInsideArea([-120.95,49.05],plan.geometry)).toBe(false);
  expect(coordinateIsInsideArea([-120.95,48.95],plan.startGeometry)).toBe(true);
  expect(()=>planLocalCoverage({...usRecipe,sources:[{...recipe.sources[0]!,geometry:rectangle([-121,45,-117,49])}]},borderStarts)).toThrow("complete 25-mile");
});

it("registers frozen outside entrances and extends their routes without bounding the whole enlarged footprint",()=>{
  const plan={...planLocalCoverage(recipe,starts),name:"Mountain core"};
  const before=structuredClone(plan);
  function* entrances():Generator<readonly [number,number]> {yield [-121.1,48.1];yield [-121.9,47.65];}
  const expanded=expandCoveragePlan(plan,recipe,entrances());
  expect(expanded).toMatchObject({id:plan.id,name:plan.name,maximumRouteMiles:40,bufferMiles:25});
  expect(subtractCoverage(plan.geometry,expanded.geometry)).toBeNull();
  expect(subtractCoverage(plan.startGeometry,expanded.startGeometry)).toBeNull();
  for(const point of [[-121.1,48.1],[-121.099,48.1],[-121.9,47.65]] as const)
    expect(coordinateIsInsideArea(point,expanded.startGeometry)).toBe(true);
  // A loop may head away from its entrance, beyond the old core buffer.
  expect(coordinateIsInsideArea([-120.6,48.1],plan.geometry)).toBe(false);
  expect(coordinateIsInsideArea([-120.6,48.1],expanded.geometry)).toBe(true);
  expect(coordinateIsInsideArea([-120.6,48.1],expanded.startGeometry)).toBe(false);
  // This corner would be swept in by buffering one bbox around core+entrances.
  expect(coordinateIsInsideArea([-122,48.4],expanded.geometry)).toBe(false);
  expect(plan).toEqual(before);
  expect(expandCoveragePlan(plan,recipe,[])).toBe(plan);
  expect(expandCoveragePlan(plan,recipe,[[-121.45,47.85]])).toBe(plan);
});

it("reapplies support and exclusions to entrance footprints and their route extensions",()=>{
  const excluded=rectangle([-121.08,48.08,-121.06,48.12]);
  const bounded={...recipe,supportedArea:{name:"Limit",geometry:rectangle([-125,45,-117,48.3])},exclusions:[{id:"hole",geometry:excluded}]};
  const plan=planLocalCoverage(bounded,starts);
  const expanded=expandCoveragePlan(plan,bounded,[[-121.1,48.1]]);
  expect(coordinateIsInsideArea([-121.07,48.1],expanded.geometry)).toBe(false);
  expect(coordinateIsInsideArea([-121.1,48.31],expanded.geometry)).toBe(false);
  expect(coordinateIsInsideArea([-121.1,48.1],expanded.startGeometry)).toBe(true);
  expect(()=>expandCoveragePlan(plan,bounded,[[-121.07,48.1]])).toThrow("outside supported coverage");
  expect(()=>constrainCoverage(bounded,excluded)).toThrow("No supported start");
});

it("fails new source gaps rather than clipping entrance routing, and accepts adjoining coverage",()=>{
  const source=rectangle([-125,45,-120.7,50]);
  const local={...recipe,sources:[{...recipe.sources[0]!,geometry:source}]};
  const plan=planLocalCoverage(local,starts);
  expect(()=>expandCoveragePlan(plan,local,[[-121.1,48.1]])).toThrow("complete 25-mile");
  const joined={...local,sources:[...local.sources,{...recipe.sources[0]!,geometry:rectangle([-120.7,45,-117,50])}]};
  expect(coordinateIsInsideArea([-120.6,48.1],expandCoveragePlan(plan,joined,[[-121.1,48.1]]).geometry)).toBe(true);
});

it("keeps entrance neighborhoods finite and rejects invalid coordinates",()=>{
  const neighborhood=entranceNeighborhood([-121,48]);
  expect(coordinateIsInsideArea([-121,48],neighborhood)).toBe(true);
  expect(coordinateIsInsideArea([-121,48.01],neighborhood)).toBe(false);
  expect(()=>entranceNeighborhood([NaN,48])).toThrow("Invalid entrance");
  expect(()=>entranceNeighborhood([-121,Infinity])).toThrow("Invalid entrance");
  expect(()=>entranceNeighborhood([-121,48],Infinity)).toThrow("Invalid entrance");
});
