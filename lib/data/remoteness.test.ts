import { describe, expect, it } from "vitest";
import { classifyRemoteness, computeLocalRelief, POPULATION_RADIUS_M, remotenessScore } from "./remoteness";
import type { NormalizedAccessPoint, NormalizedNode } from "./types";

function node(id: string, lon: number, lat: number, elevationM: number | null): NormalizedNode {
  return { id, externalId: id, lon, lat, elevationM, flags: [], sourceRefs: ["test"] };
}

function accessPoint(id: string, nodeId: string): NormalizedAccessPoint {
  return {
    id, externalId: id, nodeId, name: id, kind: "trailhead",
    accessState: "public", confidence: "high", parkingEvidence: null, sourceRefs: ["test"],
  };
}

describe("classifyRemoteness", () => {
  it("uses the 2 km population context radius", () => {
    expect(POPULATION_RADIUS_M).toBe(2_000);
  });

  it.each([
    ["Big Basin", 0.092461, "remote"],
    ["Castle Rock State Park", 14.061229, "remote"],
    ["Saratoga foothills", 3336.454398, "populated"],
    ["downtown San Jose", 20094.635255, "populated"],
  ])("classifies %s", (_label, population, expected) => {
    expect(classifyRemoteness({ populationWithinRadius: population, localReliefM: 200 })).toBe(expected);
  });

  it("separates a village edge from a suburb", () => {
    expect(classifyRemoteness({ populationWithinRadius: 400, localReliefM: 300 })).toBe("rural");
  });

  it("reports unknown rather than remote when population was never measured", () => {
    expect(classifyRemoteness({ populationWithinRadius: null, localReliefM: 900 })).toBe("unknown");
  });
});

describe("remotenessScore", () => {
  it("ranks a mountain trailhead above a suburban one", () => {
    const wild = remotenessScore({ populationWithinRadius: 0.1, localReliefM: 400 })!;
    const suburban = remotenessScore({ populationWithinRadius: 3336, localReliefM: 120 })!;
    expect(wild).toBeGreaterThan(suburban);
  });

  it("lets population outweigh relief so a hilly suburb does not pass as wild", () => {
    const hillySuburb = remotenessScore({ populationWithinRadius: 5000, localReliefM: 500 })!;
    const flatEmpty = remotenessScore({ populationWithinRadius: 0, localReliefM: 0 })!;
    expect(flatEmpty).toBeGreaterThan(hillySuburb);
  });

  it("stays within 0..1", () => {
    for (const population of [0, 1, 100, 2500, 50_000]) {
      for (const relief of [null, 0, 250, 5_000]) {
        const score = remotenessScore({ populationWithinRadius: population, localReliefM: relief })!;
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns null for an unmeasured point instead of scoring it as empty", () => {
    expect(remotenessScore({ populationWithinRadius: null, localReliefM: 100 })).toBeNull();
  });
});

describe("computeLocalRelief", () => {
  it("measures the elevation range of nearby nodes", () => {
    const nodes = [
      node("a", -122.0, 37.0, 100),
      node("b", -122.001, 37.001, 450),
      node("c", -122.002, 37.0005, 220),
    ];
    const relief = computeLocalRelief(nodes, [accessPoint("ap", "a")], 2000);
    expect(relief.get("ap")).toBe(350);
  });

  it("ignores nodes beyond the radius", () => {
    const nodes = [
      node("a", -122.0, 37.0, 100),
      node("far", -122.5, 37.0, 3000),
    ];
    const relief = computeLocalRelief(nodes, [accessPoint("ap", "a")], 2000);
    expect(relief.get("ap")).toBe(0);
  });

  it("returns null when no nearby node has elevation", () => {
    const relief = computeLocalRelief([node("a", -122.0, 37.0, null)], [accessPoint("ap", "a")], 2000);
    expect(relief.get("ap")).toBeNull();
  });

  it("finds nodes across a bucket boundary", () => {
    // Two points either side of a grid cell edge must still see each other.
    const nodes = [node("a", -121.9999, 37.0, 100), node("b", -122.0001, 37.0, 500)];
    const relief = computeLocalRelief(nodes, [accessPoint("ap", "a")], 2000);
    expect(relief.get("ap")).toBe(400);
  });

  it("returns null when the access point is not attached to a known node", () => {
    const relief = computeLocalRelief([node("a", -122, 37, 10)], [accessPoint("ap", "missing")], 2000);
    expect(relief.get("ap")).toBeNull();
  });
});
