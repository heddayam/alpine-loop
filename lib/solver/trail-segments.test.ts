import { describe, expect, it } from "vitest";
import type { ReconstructedDirectedEdge } from "@/lib/graph";
import { trailSegmentsForRoute } from "./trail-segments";

function edge(
  id: number,
  from: string,
  to: string,
  overrides: Partial<ReconstructedDirectedEdge> = {},
): ReconstructedDirectedEdge {
  return {
    id: `edge-${id}`,
    edgeKey: id,
    physicalEdgeKey: id,
    stablePhysicalEdgeId: `physical-${id}`,
    fromNodeId: from,
    toNodeId: to,
    coordinates: [[id - 1, 0], [id, 0]],
    lengthMeters: 100,
    gainMeters: 0,
    lossMeters: 0,
    minimumElevationMeters: 0,
    maximumElevationMeters: 0,
    maximumSustainedGradePct: 0,
    accessState: "public",
    edgeClass: "trail",
    trailName: null,
    sourceIds: ["osm"],
    flags: ["osm-highway:path"],
    ...overrides,
  };
}

describe("route trail segments", () => {
  it("keeps a named trail together across source ways until condition changes", () => {
    const segments = trailSegmentsForRoute("route-1", [
      edge(1, "a", "b", { trailName: "Ridge Trail", flags: ["osm-feature:way/10", "osm-highway:path", "surface:dirt"] }),
      edge(2, "b", "c", { trailName: "Ridge Trail", flags: ["osm-feature:way/11", "osm-highway:path", "surface:dirt"] }),
      edge(3, "c", "d", { trailName: "Ridge Trail", flags: ["osm-feature:way/11", "osm-highway:path", "surface:rock", "trail-visibility:bad"] }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      id: "route-1:segment:1",
      name: "Ridge Trail",
      distanceMeters: 200,
      startDistanceMeters: 0,
      endDistanceMeters: 200,
      condition: { highway: "path", surface: "dirt" },
      sourceIds: ["osm"],
    });
    expect(segments[0]?.sourceFeatureId).toBeUndefined();
    expect(segments[0]?.geometry.coordinates).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(segments[1]).toMatchObject({
      id: "route-1:segment:2",
      startDistanceMeters: 200,
      endDistanceMeters: 300,
      condition: { highway: "path", surface: "rock", trailVisibility: "bad" },
    });
  });

  it("separates adjacent unnamed source features and exposes mapped caveats", () => {
    const segments = trailSegmentsForRoute("route-2", [
      edge(1, "a", "b", { flags: ["osm-feature:way/20", "osm-highway:track", "smoothness:very_bad", "informal:yes"] }),
      edge(2, "b", "c", { accessState: "unknown", flags: ["osm-feature:way/21", "osm-highway:path", "sac-scale:mountain_hiking", "disused:yes"] }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      name: null,
      sourceFeatureId: "way/20",
      condition: { highway: "track", smoothness: "very_bad", informal: true },
    });
    expect(segments[1]).toMatchObject({
      accessState: "unknown",
      sourceFeatureId: "way/21",
      condition: { highway: "path", sacScale: "mountain_hiking", lifecycle: "disused" },
    });
  });
});
