import { describe, expect, it } from "vitest";
import type { GraphAccessPoint, GraphEdge, GraphNode } from "@/lib/graph";
import { createCandidate } from "./candidate";

describe("route candidate elevation completeness", () => {
  it("does not call a sub-resolution sustained-grade omission incomplete elevation", () => {
    const from: GraphNode = { id: "from", lon: -122, lat: 37, elevationMeters: 100, flags: [] };
    const to: GraphNode = { id: "to", lon: -121.99995, lat: 37, elevationMeters: 101, flags: [] };
    const edge: GraphEdge = {
      id: "short", fromNodeId: from.id, toNodeId: to.id,
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]], lengthMeters: 5,
      gainMeters: 1, lossMeters: 0, maximumElevationMeters: 101,
      maximumSustainedGradePct: null, accessState: "public", trailName: "Short connector",
      sourceIds: ["osm", "3dep"], flags: [],
    };
    const accessPoint: GraphAccessPoint = {
      id: "start", nodeId: from.id, name: "Start", kind: "trailhead", accessState: "public",
      confidence: "high", parkingEvidence: null, sourceIds: ["osm"],
    };
    const candidate = createCandidate("point-to-point", [{ edge, from, to }], accessPoint, {
      ...accessPoint, id: "end", nodeId: to.id,
    });

    expect(candidate.warnings).not.toContain("Elevation data is incomplete");
    expect(candidate.elevationSamples).toHaveLength(2);
  });
});
