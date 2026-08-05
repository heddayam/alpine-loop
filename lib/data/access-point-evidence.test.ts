import { describe, expect, it } from "vitest";
import type { OfficialAccessJoin } from "./authorities";
import { applyOfficialWayEvidenceToAccessPoints } from "./access-point-evidence";
import type { NormalizedTopology } from "./types";

function topology(): NormalizedTopology {
  return {
    nodes: [{ id: "node", externalId: "node/1", lon: -122, lat: 37, elevationM: null, flags: [], sourceRefs: ["osm"] }],
    ways: [{
      id: "way", externalId: "way/1", nodeIds: ["node", "node"], coordinates: [[-122, 37], [-122, 37]],
      name: "Trail", accessState: "unknown", bidirectional: true, flags: [], sourceRefs: ["osm"],
    }],
    accessPoints: [
      { id: "unknown", externalId: "node/1", nodeId: "node", name: "Trailhead", kind: "trailhead", accessState: "unknown", confidence: "low", parkingEvidence: null, sourceRefs: ["osm"] },
      { id: "unknown-parking", externalId: "node/3", nodeId: "node", name: "Unknown lot", kind: "parking", accessState: "unknown", confidence: "low", parkingEvidence: "osm:amenity=parking", sourceRefs: ["osm"] },
      { id: "private", externalId: "node/2", nodeId: "node", name: "Private lot", kind: "parking", accessState: "private", confidence: "medium", parkingEvidence: "osm:amenity=parking", sourceRefs: ["osm"] },
    ],
    rejectedWayCount: 0,
  };
}

function join(accessState: OfficialAccessJoin["evidence"]["accessState"]): OfficialAccessJoin {
  return {
    sourceId: "official",
    authorityFeatureId: "feature-1",
    targetExternalId: "way/1",
    matchMethod: "spatial-intersection",
    distanceM: 0,
    evidence: {
      externalId: "way/1", lon: -122, lat: 37, name: "Official trail",
      accessState, confidence: "high", sourceId: "official",
    },
  };
}

describe("official access evidence for trailheads", () => {
  it("promotes unknown points on officially public trails without overriding explicit restrictions", () => {
    const result = applyOfficialWayEvidenceToAccessPoints(topology(), [join("public")]);
    expect(result).toMatchObject({ promotedPublicCount: 1, restrictedCount: 0, conflictedCount: 0 });
    expect(result.topology.accessPoints.map(({ id, accessState }) => ({ id, accessState }))).toEqual([
      { id: "unknown", accessState: "public" },
      { id: "unknown-parking", accessState: "unknown" },
      { id: "private", accessState: "private" },
    ]);
    expect(result.topology.accessPoints[0].sourceRefs).toEqual(["official", "osm"]);
  });

  it("fails closed when official evidence conflicts", () => {
    const result = applyOfficialWayEvidenceToAccessPoints(topology(), [join("public"), join("closed")]);
    expect(result).toMatchObject({ promotedPublicCount: 0, restrictedCount: 0, conflictedCount: 1 });
    expect(result.topology.accessPoints[0].accessState).toBe("unknown");
  });
});
