import { describe, expect, it } from "vitest";
import {
  accessPointIsWildEnough,
  BUILDING_RADIUS_M,
  countNearbyBuildings,
  MAXIMUM_NEARBY_BUILDINGS,
} from "./wilderness";
import type { BuildingCentroid } from "./osm/buildings";
import type { NormalizedAccessPoint, NormalizedNode } from "./types";

function node(id: string, lon: number, lat: number): NormalizedNode {
  return { id, externalId: id, lon, lat, elevationM: null, flags: [], sourceRefs: ["test"] };
}

function accessPoint(id: string, nodeId: string): NormalizedAccessPoint {
  return {
    id, externalId: id, nodeId, name: id, kind: "trailhead",
    accessState: "public", confidence: "high", parkingEvidence: null, sourceRefs: ["test"],
  };
}

/** `count` buildings spread along a line east of the origin, all within 100 m. */
function cluster(count: number, lon: number, lat: number): BuildingCentroid[] {
  return Array.from({ length: count }, (_, index) => [lon + index * 0.00001, lat] as const);
}

describe("accessPointIsWildEnough", () => {
  it("is half-open at the threshold", () => {
    expect(accessPointIsWildEnough({ nearbyBuildingCount: MAXIMUM_NEARBY_BUILDINGS - 1 })).toBe(true);
    expect(accessPointIsWildEnough({ nearbyBuildingCount: MAXIMUM_NEARBY_BUILDINGS })).toBe(false);
    expect(accessPointIsWildEnough({ nearbyBuildingCount: MAXIMUM_NEARBY_BUILDINGS + 1 })).toBe(false);
  });

  it("keeps a start with a handful of neighbours", () => {
    // A park gateway beside a hamlet must survive; only built-up surroundings
    // are rejected. Fall Creek Fire Road measures 9 in the real pack.
    expect(accessPointIsWildEnough({ nearbyBuildingCount: 9 })).toBe(true);
  });
});

describe("countNearbyBuildings", () => {
  it("counts only buildings inside the radius", () => {
    const nodes = [node("a", -122, 37)];
    const near = cluster(3, -121.9999, 37);
    // ~1.1 km east, well outside the 500 m radius.
    const far = cluster(40, -121.9875, 37);
    const counts = countNearbyBuildings([...near, ...far], [accessPoint("ap", "a")], nodes);
    expect(counts.get("ap")).toBe(3);
  });

  it("finds buildings across a bucket boundary", () => {
    // The grid is one radius wide, so a match just over a cell edge must still
    // be seen by the nine-cell scan.
    const cellDegrees = BUILDING_RADIUS_M / 111_320;
    const lon = Math.ceil(-122 / cellDegrees) * cellDegrees;
    const counts = countNearbyBuildings(
      [[lon - 0.00001, 37] as const],
      [accessPoint("ap", "a")],
      [node("a", lon + 0.00001, 37)],
    );
    expect(counts.get("ap")).toBe(1);
  });

  it("reports zero for an access point with no snapped node", () => {
    const counts = countNearbyBuildings(cluster(5, -122, 37), [accessPoint("ap", "missing")], []);
    expect(counts.get("ap")).toBe(0);
  });

  it("counts each access point independently", () => {
    const nodes = [node("wild", -122, 37), node("town", -121, 36)];
    const buildings = cluster(60, -121, 36);
    const counts = countNearbyBuildings(
      buildings,
      [accessPoint("wild", "wild"), accessPoint("town", "town")],
      nodes,
    );
    expect(counts.get("wild")).toBe(0);
    expect(counts.get("town")).toBe(60);
  });
});
