import { expect, it } from "vitest";
import fixture from "@/data/fixtures/coverage/washington-seams.json";
import { coordinateIsInsideArea, lineIsInsideArea, segmentIntersectsArea, segmentIsInsideArea } from "@/lib/graph/geometry";
import { intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import { planCoverageRegion } from "./plan";
import { readCoverageRegion } from "./regions";

type Position = [number, number];
const expectedCounts:Record<string,number>={"north-central":6,"central-rainier":16,"rainier-southwest":2};

// Coordinates come from pinned source ways, never from the polygons under test.
for (const seam of fixture.seams) {
  it(`preserves the reviewed ${seam.id} source lines without requiring graph stitching`,async()=>{
    const regions=await Promise.all(seam.regionIds.map(readCoverageRegion));
    const plans=regions.map(planCoverageRegion);
    const eligibleStarts=unionCoverage(plans.map(plan=>plan.startGeometry));
    const routingSupport=unionCoverage(plans.map(plan=>plan.geometry));
    const lines=fixture.features.filter(feature=>feature.properties.seam===seam.id);
    expect(lines).toHaveLength(expectedCounts[seam.id]!);
    for(const feature of lines) {
      const coordinates=feature.geometry.coordinates as Position[];
      const policy=fixture.intentionalExclusions.find(exclusion=>exclusion.wayId===feature.id);
      const excluded=policy ? unionCoverage(regions.map(region=>{
        const exclusion=region.recipe.exclusions.find(exclusion=>exclusion.id===policy.exclusionId);
        expect(exclusion,`${region.id}: preserve the explicit ${policy.exclusionId} limit`).toBeDefined();
        return exclusion!.geometry;
      })) : undefined;
      if(excluded) {
        expect(coordinates.slice(1).flatMap((end,index)=>segmentIntersectsArea(coordinates[index]!,end,excluded)?[index]:[]),
          `${feature.id}: intentional exclusion scope changed`).toEqual(policy!.intersectingSegments);
        expect(intersectCoverage(eligibleStarts,excluded)).toBeNull();
        for(const plan of plans) expect(intersectCoverage(plan.geometry,excluded),plan.id).toBeNull();
      }
      // Mask only the fixture's explicit policy carve-out; do not infer continuity
      // through it or tolerate other missing sections of these reviewed ways.
      // Mountain cores select starts; a reviewed trail can traverse a valley or
      // another core. Preserve its complete routing support, not a land tessellation.
      const coverage=excluded ? unionCoverage([routingSupport,excluded]) : routingSupport;
      const outside=coordinates.slice(1).flatMap((end,index)=>segmentIsInsideArea(coordinates[index]!,end,coverage)
        ? [] : [{segment:index,from:coordinates[index],to:end}]);
      expect(outside,`${feature.id} ${feature.properties.name}: lost routing support`).toEqual([]);
      expect(plans.some(plan=>lineIsInsideArea(coordinates,excluded ? unionCoverage([plan.geometry,excluded]) : plan.geometry)),
        `${feature.id} ${feature.properties.name}: no independent graph covers the complete non-excluded line`).toBe(true);
    }
  });
}

it("detects a missing middle segment even when both source vertices are covered",()=>{
  const line:Position[]=[[0.5,0.5],[2.5,0.5]];
  const disconnected=unionCoverage([rectangle([0,0,1,1]),rectangle([2,0,3,1])]);
  const hole=subtractCoverage(rectangle([0,0,3,1]),rectangle([1,0.25,2,0.75]))!;
  for(const coverage of [disconnected,hole]) {
    expect(line.every(point=>coordinateIsInsideArea(point,coverage))).toBe(true);
    expect(lineIsInsideArea(line,coverage)).toBe(false);
  }
  const overlapping=unionCoverage([rectangle([0,0,2,1]),rectangle([1,0,3,1])]);
  expect(lineIsInsideArea(line,overlapping)).toBe(true);
});
