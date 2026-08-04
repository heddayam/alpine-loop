import { describe, expect, it } from "vitest";
import type { NormalizedAccessEvidence } from "../adapters";
import type { Coordinate, NormalizedTopology, NormalizedWay } from "../types";
import {
  matchOfficialAccessToOsm,
  matchOfficialAccessToOsmWithReport,
} from "./spatial-match";
import type { OfficialAccessJoinFeature } from "./types";

function way(externalId: string, coordinates: Coordinate[]): NormalizedWay {
  return {
    id: `normalized-${externalId}`,
    externalId,
    nodeIds: coordinates.map((_, index) => `${externalId}-node-${index}`),
    coordinates,
    name: null,
    accessState: "unknown",
    bidirectional: true,
    sourceRefs: ["osm-fixture"],
    flags: [],
  };
}

function topology(ways: NormalizedWay[]): NormalizedTopology {
  return { nodes: [], ways, accessPoints: [], rejectedWayCount: 0 };
}

function evidence(sourceId: string, accessState: NormalizedAccessEvidence["accessState"]): NormalizedAccessEvidence {
  return {
    sourceId,
    externalId: "authority-original-id",
    lon: -122,
    lat: 37,
    name: "Official trail",
    accessState,
    confidence: "high",
  };
}

function feature(
  authorityFeatureId: string,
  coordinates: number[][] | number[][][],
  options: { sourceId?: string; multi?: boolean; accessState?: NormalizedAccessEvidence["accessState"] } = {},
): OfficialAccessJoinFeature {
  const sourceId = options.sourceId ?? "official-source";
  return {
    sourceId,
    authorityFeatureId,
    geometry: options.multi
      ? { type: "MultiLineString", coordinates: coordinates as number[][][] }
      : { type: "LineString", coordinates: coordinates as number[][] },
    evidence: evidence(sourceId, options.accessState ?? "closed"),
  };
}

describe("official access spatial matching", () => {
  it("matches aligned geometry within the conservative default tolerance and remaps evidence identity", () => {
    const input = topology([way("way/10", [[-122, 37], [-121.999, 37]])]);
    const joins = matchOfficialAccessToOsm(input, [
      feature("authority-10", [[-122, 37.0001], [-121.999, 37.0001]]),
    ]);

    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      sourceId: "official-source",
      authorityFeatureId: "authority-10",
      targetExternalId: "way/10",
      matchMethod: "nearest-within-tolerance",
      evidence: { sourceId: "official-source", externalId: "way/10", accessState: "closed" },
    });
    expect(joins[0].distanceM).toBeGreaterThan(10);
    expect(joins[0].distanceM).toBeLessThan(12);
  });

  it("does not promote permissive evidence outside tolerance", () => {
    const input = topology([way("way/20", [[-122, 37], [-121.999, 37]])]);
    const result = matchOfficialAccessToOsmWithReport(input, [
      feature("too-far", [[-122, 37.0003], [-121.999, 37.0003]], { accessState: "public" }),
    ]);

    expect(result).toEqual({ joins: [], ambiguousOsmWayCount: 0, unmatchedAuthorityFeatureCount: 1 });
  });

  it("does not treat separated collinear segments as an intersection", () => {
    const input = topology([way("way/collinear-gap", [[-121.9987, 37], [-121.998, 37]])]);
    const joins = matchOfficialAccessToOsm(input, [
      feature("gap", [[-121.999, 37], [-121.9989, 37]], { accessState: "public" }),
    ]);

    expect(joins).toEqual([]);
  });

  it("rejects ties and chooses only the stable nearest feature per authority source", () => {
    const input = topology([
      way("way/tie", [[-122, 37], [-121.999, 37]]),
      way("way/nearest", [[-122, 37.001], [-121.999, 37.001]]),
    ]);
    const result = matchOfficialAccessToOsmWithReport(input, [
      feature("tie-a", [[-122, 37], [-121.999, 37]]),
      feature("tie-b", [[-122, 37], [-121.999, 37]]),
      feature("near", [[-122, 37.00105], [-121.999, 37.00105]]),
      feature("farther", [[-122, 37.00115], [-121.999, 37.00115]]),
    ]);

    expect(result.ambiguousOsmWayCount).toBe(1);
    expect(result.joins).toHaveLength(1);
    expect(result.joins[0]).toMatchObject({ authorityFeatureId: "near", targetExternalId: "way/nearest" });
    expect(result.unmatchedAuthorityFeatureCount).toBe(3);
  });

  it("matches MultiLineString authority geometry to multiple contiguous OSM ways", () => {
    const first = way("way/1", [[-122, 37], [-121.9995, 37]]);
    const second = way("way/2", [[-121.9995, 37], [-121.999, 37]]);
    const official = feature("multi", [
      [[-122, 37], [-121.9995, 37]],
      [[-121.9995, 37], [-121.999, 37]],
    ], { multi: true });

    expect(matchOfficialAccessToOsm(topology([second, first]), [official])).toMatchObject([
      { authorityFeatureId: "multi", targetExternalId: "way/1", matchMethod: "spatial-intersection" },
      { authorityFeatureId: "multi", targetExternalId: "way/2", matchMethod: "spatial-intersection" },
    ]);
  });

  it("returns stable ordering regardless of topology and authority input order", () => {
    const ways = [
      way("way/b", [[-122, 37.001], [-121.999, 37.001]]),
      way("way/a", [[-122, 37], [-121.999, 37]]),
    ];
    const features = [
      feature("feature-b", [[-122, 37.001], [-121.999, 37.001]], { sourceId: "source-b" }),
      feature("feature-a", [[-122, 37], [-121.999, 37]], { sourceId: "source-a" }),
    ];
    const forward = matchOfficialAccessToOsm(topology(ways), features);
    const reversed = matchOfficialAccessToOsm(topology([...ways].reverse()), [...features].reverse());

    expect(forward).toEqual(reversed);
    expect(forward.map(({ sourceId, targetExternalId }) => [sourceId, targetExternalId])).toEqual([
      ["source-a", "way/a"],
      ["source-b", "way/b"],
    ]);
  });

  it("does not mistake a perpendicular crossing for aligned trail geometry", () => {
    const input = topology([
      way("way/crossing", [[-122, 36.9995], [-122, 37.0005]]),
      way("way/shallow-crossing", [[-122.0005, 36.99965], [-121.9995, 37.00035]]),
    ]);
    const joins = matchOfficialAccessToOsm(input, [
      feature("east-west", [[-122.0005, 37], [-121.9995, 37]]),
    ]);

    expect(joins).toEqual([]);
  });
});
