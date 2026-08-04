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

  it("decodes OPL escapes while preserving literal percent text that resembles hex", () => {
    const topology = normalizeOsmOpl([
      'n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tnote=Track%20%beyond%20%gate x-122.2 y37.2',
      'n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2',
      'w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Caf%C3%A9 Nn1,n2',
    ].join("\n"), "osm-fixture");
    expect(topology.ways[0]?.name).toBe("Café");
  });
});
