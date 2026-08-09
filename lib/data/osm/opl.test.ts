import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOsmOpl } from "./opl";

describe("OSM OPL normalization", () => {
  it("preserves exact OSM node references instead of connecting coordinate-only crossings", async () => {
    const contents = await readFile(path.resolve("data/fixtures/source/osm/hiking.opl"), "utf8");
    const topology = normalizeOsmOpl(contents, "osm-fixture");

    expect(topology.ways).toHaveLength(3);
    expect(topology.rejectedWayCount).toBe(0);
    expect(topology.ways[0].nodeIds).toEqual(["osm-node-1", "osm-node-2", "osm-node-3"]);
    expect(topology.ways[1].nodeIds).toEqual(["osm-node-4", "osm-node-3"]);
    expect(topology.ways.map(({ edgeClass }) => edgeClass)).toEqual(["trail", "trail", "street"]);
    expect(topology.ways[0].flags).toEqual(expect.arrayContaining([
      "osm-feature:way/101", "osm-highway:path", "surface:dirt",
    ]));
    expect(topology.accessPoints).toEqual([]);
    expect(topology.portalEvidence?.map(({ externalId }) => externalId).sort()).toEqual(["node/1", "node/4"]);
  });

  it("preserves condition tags identically to GeoJSON normalization", () => {
    const topology = normalizeOsmOpl([
      "n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.2 y37.2",
      "n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2",
      "w9 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,surface=rock,smoothness=bad,trail_visibility=intermediate,sac_scale=hiking,informal=no,abandoned=yes Nn1,n2",
    ].join("\n"), "osm-fixture");

    expect(topology.ways[0].flags).toEqual([
      "osm-feature:way/9",
      "osm-highway:path",
      "surface:rock",
      "smoothness:bad",
      "trail-visibility:intermediate",
      "sac-scale:hiking",
      "informal:no",
      "abandoned:yes",
    ]);
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

  it("normalizes parking, trailhead, information and gate features as portal evidence", () => {
    const topology = normalizeOsmOpl([
      "n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.2 y37.2",
      "n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2",
      "n3 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.195 y37.201",
      "n4 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.194 y37.201",
      "n5 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.194 y37.202",
      "n6 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tbarrier=gate,foot=yes,name=Ridge%20%Trailhead%20%Entrance x-122.19 y37.2",
      "n7 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tbarrier=gate,foot=yes,name=MB01 x-122.191 y37.2",
      "n8 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tinformation=guidepost,name=Junction x-122.192 y37.2",
      "n9 v1 dV c0 t2026-01-01T00:00:00Z i0 u Ttourism=information x-122.193 y37.2",
      "n10 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=trailhead x-122.194 y37.2",
      "n11 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tinformation=trailhead x-122.195 y37.2",
      "w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Ridge%20%Trail Nn1,n2",
      "w2 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tamenity=parking,name=Ridge%20%Lot,access=yes Nn3,n4,n5,n3",
      "w3 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tamenity=parking,name=Private%20%Lot,access=private Nn3,n4,n5,n3",
      "w4 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tamenity=parking,name=Unverified%20%Lot Nn3,n4,n5,n3",
    ].join("\n"), "osm-fixture");

    expect(topology.accessPoints).toEqual([]);
    expect(topology.portalEvidence?.map(({ externalId }) => externalId).sort()).toEqual([
      "node/10", "node/11", "node/6", "node/7", "node/8", "node/9", "way/2", "way/3", "way/4",
    ]);
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "way/2")).toMatchObject({
      name: "Ridge Lot",
      kind: "parking",
      accessState: "public",
      nodeIds: ["osm-node-3", "osm-node-4", "osm-node-5", "osm-node-3"],
      coordinates: [[-122.195, 37.201], [-122.194, 37.201], [-122.194, 37.202], [-122.195, 37.201]],
    });
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/6")).toMatchObject({
      name: "Ridge Trailhead Entrance",
      kind: "gate",
      accessState: "public",
      nodeIds: ["osm-node-6"],
      coordinates: [[-122.19, 37.2]],
    });
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/7")?.kind).toBe("gate");
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/8")?.kind).toBe("information");
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/9")?.kind).toBe("information");
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/10")?.kind).toBe("trailhead");
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/11")?.kind).toBe("trailhead");
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "way/3")?.accessState).toBe("private");
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "way/4")?.accessState).toBe("unknown");
  });

  it("classifies retained OPL trail, sidewalk, service-road and street context", () => {
    const topology = normalizeOsmOpl([
      "n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.2 y37.2",
      "n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2",
      "w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=footway Nn1,n2",
      "w2 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=footway,name=Creek%20%Trail Nn1,n2",
      "w3 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=track,motor_vehicle=yes,foot=no Nn1,n2",
      "w4 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=secondary Nn1,n2",
    ].join("\n"), "osm-fixture");

    expect(topology.ways.map(({ edgeClass }) => edgeClass)).toEqual([
      "trail", "trail", "service-road", "street",
    ]);
  });

  it("promotes untagged footway components only when they connect to an explicit trail", () => {
    const topology = normalizeOsmOpl([
      "n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.2 y37.2",
      "n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2",
      "n3 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.18 y37.2",
      "n4 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.17 y37.2",
      "n5 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.16 y37.2",
      "n6 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.15 y37.2",
      "w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path Nn1,n2",
      "w2 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=footway Nn2,n3",
      "w3 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=footway Nn3,n4",
      "w4 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=footway Nn5,n6",
      "w5 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=footway,footway=sidewalk Nn1,n6",
    ].join("\n"), "osm-fixture");

    expect(topology.ways.map(({ externalId, edgeClass }) => ({ externalId, edgeClass }))).toEqual([
      { externalId: "way/1", edgeClass: "trail" },
      { externalId: "way/2", edgeClass: "trail" },
      { externalId: "way/3", edgeClass: "trail" },
      { externalId: "way/4", edgeClass: "sidewalk" },
      { externalId: "way/5", edgeClass: "sidewalk" },
    ]);
  });
});
