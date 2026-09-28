import { expect, it } from "vitest";
import { areaGeometryBounds } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { rectangle } from "./geometry";
import { planLocalCoverage } from "./plan";
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
