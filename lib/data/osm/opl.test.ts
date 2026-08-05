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

  it("decodes hexadecimal, UTF-8, and single-character OPL escapes", () => {
    const topology = normalizeOsmOpl([
      'n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tnote=Track%20%beyond%20%gate x-122.2 y37.2',
      'n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2',
      'w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Track%20%beyond%20%gate Nn1,n2',
      'w2 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Caf%C3%A9 Nn2,n1',
      'w3 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Sierra%20%Azul%2c%%20%Kennedy Nn1,n2',
    ].join("\n"), "osm-fixture");
    expect(topology.ways.map(({ name }) => name)).toEqual(["Track beyond gate", "Café", "Sierra Azul, Kennedy"]);
  });

  it("normalizes parking areas and pedestrian gates as trail access points", () => {
    const topology = normalizeOsmOpl([
      "n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.2 y37.2",
      "n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2",
      "n3 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.195 y37.201",
      "n4 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.194 y37.201",
      "n5 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.194 y37.202",
      "n6 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tbarrier=gate,foot=yes,name=Ridge%20%Trailhead%20%Entrance x-122.19 y37.2",
      "n7 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tbarrier=gate,foot=yes,name=MB01 x-122.191 y37.2",
      "w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Ridge%20%Trail Nn1,n2",
      "w2 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tamenity=parking,name=Ridge%20%Lot,access=yes Nn3,n4,n5,n3",
      "w3 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tamenity=parking,name=Private%20%Lot,access=private Nn3,n4,n5,n3",
      "w4 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tamenity=parking,name=Unverified%20%Lot Nn3,n4,n5,n3",
    ].join("\n"), "osm-fixture");

    expect(topology.accessPoints.map(({ externalId }) => externalId).sort()).toEqual([
      "node/6", "way/2", "way/3", "way/4",
    ]);
    expect(topology.accessPoints.find(({ externalId }) => externalId === "way/2")).toMatchObject({
      name: "Ridge Lot",
      kind: "parking",
      parkingEvidence: "osm:amenity=parking-area",
      accessState: "public",
    });
    expect(topology.accessPoints.find(({ externalId }) => externalId === "node/6")).toMatchObject({
      name: "Ridge Trailhead Entrance",
      kind: "trailhead",
      accessState: "public",
    });
    expect(topology.accessPoints.find(({ externalId }) => externalId === "way/3")?.accessState).toBe("private");
    expect(topology.accessPoints.find(({ externalId }) => externalId === "way/4")?.accessState).toBe("unknown");
  });
});
