import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOsmOpl } from "./opl";

describe("OSM OPL normalization", () => {
  it("preserves exact OSM node references instead of connecting coordinate-only crossings", async () => {
    const contents = await readFile(path.resolve("data/fixtures/source/osm/hiking.opl"), "utf8");
    const topology = normalizeOsmOpl(contents, "osm-fixture");

    expect(topology.ways).toHaveLength(2);
    expect(topology.rejectedWayCount).toBe(1);
    expect(topology.ways[0].nodeIds).toEqual(["osm-node-1", "osm-node-2", "osm-node-3"]);
    expect(topology.ways[1].nodeIds).toEqual(["osm-node-4", "osm-node-3"]);
    expect(topology.accessPoints.map(({ externalId }) => externalId).sort()).toEqual(["node/1", "node/4"]);
  });
});
