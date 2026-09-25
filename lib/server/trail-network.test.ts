import { describe, expect, it } from "vitest";
import type { FeatureCollection, LineString } from "geojson";
import { groupContiguousTrailFeatures } from "./trail-network";

function networkFeature(
  id: string,
  name: string | null,
  distanceMeters: number,
  coordinates: LineString["coordinates"],
): FeatureCollection<LineString>["features"][number] {
  return {
    type: "Feature",
    properties: { id, name, distanceMeters },
    geometry: { type: "LineString", coordinates },
  };
}

describe("contiguous trail-network groups", () => {
  it("groups touching edges of one named trail and sums their physical distance", () => {
    const grouped = groupContiguousTrailFeatures({
      type: "FeatureCollection",
      features: [
        networkFeature("one", " Ridge Trail ", 100, [[0, 0], [1, 0]]),
        networkFeature("two", "ridge trail", 125, [[1, 0], [2, 0]]),
        networkFeature("three", "Ridge Trail", 75, [[2, 0], [3, 0]]),
      ],
    });

    expect(grouped.features).toHaveLength(1);
    expect(grouped.features[0]?.properties?.distanceMeters).toBe(300);
    expect(grouped.features[0]?.geometry.coordinates).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it("keeps disconnected same-name trails and touching different names separate while joining unnamed chains", () => {
    const grouped = groupContiguousTrailFeatures({
      type: "FeatureCollection",
      features: [
        networkFeature("ridge-west", "Ridge Trail", 100, [[0, 0], [1, 0]]),
        networkFeature("ridge-east", "Ridge Trail", 100, [[3, 0], [4, 0]]),
        networkFeature("creek", "Creek Trail", 50, [[1, 0], [2, 0]]),
        networkFeature("unnamed-one", null, 25, [[5, 0], [6, 0]]),
        networkFeature("unnamed-two", null, 25, [[6, 0], [7, 0]]),
      ],
    });

    expect(new Set(grouped.features.map((feature) => feature.properties?.trailGroupId))).toHaveLength(4);
    expect(grouped.features).toHaveLength(4);
    expect(grouped.features[3]?.properties?.distanceMeters).toBe(50);
    expect(grouped.features[3]?.geometry.coordinates).toEqual([[5, 0], [6, 0], [7, 0]]);
  });

  it("stops unnamed grouping where three or more branches meet", () => {
    const grouped = groupContiguousTrailFeatures({
      type: "FeatureCollection",
      features: [
        networkFeature("west", null, 25, [[0, 0], [1, 0]]),
        networkFeature("east", null, 25, [[1, 0], [2, 0]]),
        networkFeature("north", null, 25, [[1, 0], [1, 1]]),
      ],
    });

    expect(new Set(grouped.features.map((feature) => feature.properties?.trailGroupId))).toHaveLength(3);
  });
});
