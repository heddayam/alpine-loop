import { describe, expect, it } from "vitest";
import type { NormalizedTopology } from "./types";
import { snapAccessPointsToTopology } from "./access-point-snap";

function topology(): NormalizedTopology {
  return {
    nodes: [
      { id: "a", externalId: "a", lon: -122, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] },
      { id: "b", externalId: "b", lon: -121.999, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] },
      { id: "near", externalId: "near", lon: -122.0001, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] },
      { id: "far", externalId: "far", lon: -122.01, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] },
    ],
    ways: [{
      id: "way", externalId: "way/1", nodeIds: ["a", "b"], coordinates: [[-122, 37], [-121.999, 37]],
      name: "Trail", accessState: "public", bidirectional: true, sourceRefs: ["osm"], flags: [],
    }],
    accessPoints: [
      { id: "connected", externalId: "node/1", nodeId: "a", name: "Connected", kind: "trailhead", accessState: "public", confidence: "medium", parkingEvidence: null, sourceRefs: ["osm"] },
      { id: "nearby", externalId: "node/2", nodeId: "near", name: "Nearby", kind: "parking", accessState: "public", confidence: "medium", parkingEvidence: "osm:amenity=parking", sourceRefs: ["osm"] },
      { id: "distant", externalId: "node/3", nodeId: "far", name: "Distant", kind: "parking", accessState: "unknown", confidence: "low", parkingEvidence: "osm:amenity=parking", sourceRefs: ["osm"] },
    ],
    rejectedWayCount: 2,
  };
}

describe("access-point snapping", () => {
  it("connects nearby points, preserves connected points, and rejects distant points", () => {
    const result = snapAccessPointsToTopology(topology(), 100);
    expect(result).toMatchObject({
      snappedCount: 1,
      alreadyConnectedCount: 1,
      deduplicatedCount: 0,
      rejectedAccessPointIds: ["distant"],
    });
    expect(result.topology.nodes.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result.topology.accessPoints.map(({ id, nodeId }) => ({ id, nodeId }))).toEqual([
      { id: "connected", nodeId: "a" },
      { id: "nearby", nodeId: "a" },
    ]);
  });

  it("rejects invalid tolerances", () => {
    expect(() => snapAccessPointsToTopology(topology(), 0)).toThrow(/positive finite/);
  });

  it("accepts a 199 m snap and rejects a 201 m snap", () => {
    const input = topology();
    input.nodes.find(({ id }) => id === "near")!.lon = -122;
    input.nodes.find(({ id }) => id === "near")!.lat = 37 + 199 / 111_195;
    input.nodes.find(({ id }) => id === "far")!.lon = -122;
    input.nodes.find(({ id }) => id === "far")!.lat = 37 + 201 / 111_195;
    const result = snapAccessPointsToTopology(input, 200);
    expect(result.topology.accessPoints.map(({ id }) => id)).toEqual(["connected", "nearby"]);
    expect(result.rejectedAccessPointIds).toEqual(["distant"]);
  });

  it("replaces a generic duplicate with a named point at the same snapped node", () => {
    const input = topology();
    input.accessPoints = [
      { ...input.accessPoints[0], id: "generic", name: "OSM parking", kind: "parking" },
      { ...input.accessPoints[0], id: "named", name: "Ridge Lot", kind: "parking" },
    ];
    const result = snapAccessPointsToTopology(input, 100);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.topology.accessPoints.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "named", name: "Ridge Lot" },
    ]);
  });

  it("drops generic parking when a named trailhead uses the same snapped node", () => {
    const input = topology();
    input.accessPoints = [
      { ...input.accessPoints[0], id: "parking", name: "OSM parking", kind: "parking" },
      { ...input.accessPoints[0], id: "trailhead", name: "Hoffman Creek Trailhead", kind: "trailhead" },
    ];
    const result = snapAccessPointsToTopology(input, 100);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.topology.accessPoints.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      { id: "trailhead", name: "Hoffman Creek Trailhead", kind: "trailhead" },
    ]);
  });
});
