import { describe, expect, it } from "vitest";
import type { NormalizedAccessEvidence } from "./adapters";
import { addOfficialAccessPointsToTopology, officialAccessPointId } from "./official-access-points";
import type { NormalizedTopology } from "./types";

function topology(): NormalizedTopology {
  return {
    nodes: [
      { id: "a", externalId: "a", lon: -122, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] },
      { id: "b", externalId: "b", lon: -121.999, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] },
    ],
    ways: [{
      id: "way", externalId: "way/1", nodeIds: ["a", "b"], coordinates: [[-122, 37], [-121.999, 37]],
      name: "Trail", accessState: "public", bidirectional: true, sourceRefs: ["osm"], flags: [],
    }],
    accessPoints: [{
      id: "osm-generic", externalId: "node/1", nodeId: "a", name: "OSM trailhead", kind: "trailhead",
      accessState: "unknown", confidence: "low", parkingEvidence: null, sourceRefs: ["osm"],
    }],
    rejectedWayCount: 0,
  };
}

function entrance(
  externalId: string,
  lat: number,
  accessState: NormalizedAccessEvidence["accessState"] = "public",
): NormalizedAccessEvidence {
  return {
    sourceId: "ebrpd-entrances",
    externalId,
    lon: -122,
    lat,
    name: `${externalId} Entrance`,
    accessState,
    confidence: "high",
  };
}

describe("official access points", () => {
  it("snaps in-range authority entrances, preserves evidence, rejects out-of-range points, and prefers a named official duplicate", () => {
    const publicEntrance = entrance("public", 37.0001, "public");
    const closedEntrance = entrance("closed", 37.0008, "closed");
    closedEntrance.lon = -121.999;
    const distantEntrance = entrance("distant", 37.01, "unknown");
    const result = addOfficialAccessPointsToTopology(topology(), [distantEntrance, publicEntrance, closedEntrance], 100);

    expect(result).toMatchObject({ addedCount: 2, rejectedCount: 1, deduplicatedCount: 1 });
    expect(result.addedAccessPointIds).toEqual([
      officialAccessPointId(closedEntrance),
      officialAccessPointId(publicEntrance),
    ]);
    expect(result.rejectedAccessPointIds).toEqual([officialAccessPointId(distantEntrance)]);
    expect(result.deduplicatedAccessPointIds).toEqual(["osm-generic"]);
    expect(result.topology.nodes).toEqual(topology().nodes);
    expect(result.topology.ways).toEqual(topology().ways);
    expect(result.topology.accessPoints.map(({ id, nodeId, accessState, confidence, sourceRefs }) => ({
      id, nodeId, accessState, confidence, sourceRefs,
    }))).toEqual([
      { id: officialAccessPointId(closedEntrance), nodeId: "b", accessState: "closed", confidence: "high", sourceRefs: ["ebrpd-entrances"] },
      { id: officialAccessPointId(publicEntrance), nodeId: "a", accessState: "public", confidence: "high", sourceRefs: ["ebrpd-entrances"] },
    ]);
  });

  it("is deterministic across evidence ordering and generates stable IDs", () => {
    const first = entrance("alpha", 37.0001);
    first.lon = -121.999;
    const second = entrance("beta", 37.0001);
    const forward = addOfficialAccessPointsToTopology(topology(), [first, second], 100);
    const reverse = addOfficialAccessPointsToTopology(topology(), [second, first], 100);

    expect(forward).toEqual(reverse);
    expect(officialAccessPointId(first)).toBe("official-access:ebrpd-entrances:alpha");
    expect(forward.topology.accessPoints.map(({ id }) => id)).toEqual([
      officialAccessPointId(first),
      officialAccessPointId(second),
    ]);
  });

  it("rejects invalid distances and duplicate evidence", () => {
    const duplicate = entrance("duplicate", 37);
    expect(() => addOfficialAccessPointsToTopology(topology(), [duplicate], 0)).toThrow(/positive finite/);
    expect(() => addOfficialAccessPointsToTopology(topology(), [duplicate, { ...duplicate }], 100)).toThrow(/Duplicate official access evidence/);
  });
});
