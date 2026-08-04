import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOsmFeatures, osmAccessState, readOsmGeoJsonSequence } from "./normalize";

const fixturePath = path.resolve("data/fixtures/source/osm/hiking.geojsonseq");

describe("OSM hiking topology normalization", () => {
  it("normalizes pedestrian ways, stable intersections, access points and direction", async () => {
    const topology = normalizeOsmFeatures(await readOsmGeoJsonSequence(fixturePath), "osm-fixture");

    expect(topology.ways).toHaveLength(2);
    expect(topology.rejectedWayCount).toBe(1);
    expect(topology.accessPoints).toHaveLength(2);
    expect(topology.ways[0]).toMatchObject({ accessState: "public", bidirectional: true });
    expect(topology.ways[1]).toMatchObject({ accessState: "private", bidirectional: false });
    expect(topology.ways[1].coordinates[0]).toEqual([-122.17, 37.19]);
    expect(topology.accessPoints.map(({ accessState }) => accessState)).toEqual(["public", "unknown"]);
    expect(new Set(topology.nodes.map(({ id }) => id)).size).toBe(topology.nodes.length);
  });

  it("defaults ambiguous access to unknown and retains explicit restrictions", () => {
    expect(osmAccessState({})).toBe("unknown");
    expect(osmAccessState({ access: "no" })).toBe("prohibited");
    expect(osmAccessState({ foot: "private", access: "yes" })).toBe("private");
  });
});
