import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { normalizeOsmOpl, parseOplTags, readAndNormalizeOsmOpl } from "./opl";

describe("OSM OPL normalization", () => {
  it("reports empty and malformed streamed extracts with their original line numbers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-opl-"));
    const filePath = path.join(directory, "hiking.opl");
    try {
      await writeFile(filePath, "\n  \r\n");
      await expect(readAndNormalizeOsmOpl(filePath, "fixture")).rejects.toThrow("OSM OPL extraction is empty");
      await writeFile(filePath, "\r\nn1 x0 y0\r\nn2 xbad y0\r\n");
      await expect(readAndNormalizeOsmOpl(filePath, "fixture")).rejects.toThrow("invalid coordinates at line 3");
      await writeFile(filePath, "n1 x0 y0\nw1 Thighway=path Nn1\n");
      await expect(readAndNormalizeOsmOpl(filePath, "fixture")).rejects.toThrow("fewer than two nodes at line 2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves exact OSM node references instead of connecting coordinate-only crossings", async () => {
    const contents = await readFile(path.resolve("data/fixtures/source/osm/hiking.opl"), "utf8");
    const topology = normalizeOsmOpl(contents, "osm-fixture");

    expect(await readAndNormalizeOsmOpl(path.resolve("data/fixtures/source/osm/hiking.opl"), "osm-fixture"))
      .toEqual(topology);
    expect(topology.ways).toHaveLength(3);
    expect(topology.ways[0]).toMatchObject({ accessState: "public", bidirectional: true });
    expect(topology.ways[1]).toMatchObject({ accessState: "private", bidirectional: false });
    expect(topology.ways[1].coordinates[0]).toEqual([-122.17, 37.19]);
    expect(topology.portalEvidence?.map(({ accessState }) => accessState)).toEqual(["public", "unknown"]);
    expect(new Set(topology.nodes.map(({ id }) => id)).size).toBe(topology.nodes.length);
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

  it("preserves observed condition tags without interpreting maintenance", () => {
    const topology = normalizeOsmOpl([
      "n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.2 y37.2",
      "n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2",
      "w9 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,surface=rock,smoothness=bad,trail_visibility=intermediate,sac_scale=hiking,informal=no,disused=yes,abandoned=yes Nn1,n2",
    ].join("\n"), "osm-fixture");

    expect(topology.ways[0].flags).toEqual([
      "osm-feature:way/9",
      "osm-highway:path",
      "motor-access:unknown",
      "surface:rock",
      "smoothness:bad",
      "trail-visibility:intermediate",
      "sac-scale:hiking",
      "informal:no",
      "disused:yes",
      "abandoned:yes",
    ]);
  });

  it("retains non-gate passages on actual source nodes and keeps information object access separate", () => {
    const topology = normalizeOsmOpl([
      "n1 Tbarrier=bollard,foot=yes,motor_vehicle=no x0 y0",
      "n2 Tfoot=no x0.001 y0",
      "n3 Tinformation=board,access=private x0.002 y0",
      "n4 Tbarrier=stile,foot=private x0.003 y0",
      "n5 Tbarrier=gate x0.004 y0",
      "n6 Tfoot=private x0.1 y0",
      "w1 Thighway=track,foot=yes,motorcar=private,oneway=yes Nn1,n2,n3,n4,n5",
    ].join("\n"), "fixture");
    const node = (id: string) => topology.nodes.find(value => value.externalId === `node/${id}`)!;
    expect(node("1").flags).toEqual(expect.arrayContaining(["barrier:bollard", "foot-access:public", "motor-access:prohibited"]));
    expect(node("2").flags).toContain("foot-access:prohibited");
    expect(node("3").flags).not.toContain("foot-access:private");
    expect(node("4").flags).toEqual(expect.arrayContaining(["barrier:stile", "foot-access:private"]));
    expect(node("5").flags).toEqual(["barrier:gate"]);
    expect(node("6").flags).toContain("foot-access:private");
    expect(topology.ways[0]).toMatchObject({ edgeClass: "trail", accessState: "public", bidirectional: true });
    expect(topology.portalEvidence?.map(evidence => evidence.externalId)).toEqual(["node/3", "node/5"]);
  });

  it("decodes delimited Unicode OPL escapes", () => {
    const topology = normalizeOsmOpl([
      'n1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Tnote=Track%20%beyond%20%gate x-122.2 y37.2',
      'n2 v1 dV c0 t2026-01-01T00:00:00Z i0 u x-122.19 y37.2',
      'w1 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Track%20%beyond%20%gate Nn1,n2',
      'w2 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=path,name=Caf%e9% Nn2,n1',
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
    expect(topology.portalEvidence?.find(({ externalId }) => externalId === "node/9"))
      .toMatchObject({ kind: "information", name: null, coordinates: [[-122.193, 37.2]] });
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
      "trail", "trail", "trail", "street",
    ]);
  });

  it("includes isolated unlabelled walking links without a distant trail dependency", () => {
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
      { externalId: "way/4", edgeClass: "trail" },
      { externalId: "way/5", edgeClass: "sidewalk" },
    ]);
    const isolated = normalizeOsmOpl("n5 x0 y0\nn6 x1 y0\nw4 Thighway=footway,foot=private,oneway:foot=-1 Nn5,n6", "osm-fixture").ways[0];
    expect(isolated).toMatchObject({ edgeClass: "trail", accessState: "private", bidirectional: false, nodeIds: ["osm-node-6", "osm-node-5"] });
    expect(isolated.flags).toContain("possible-walking-link");
  });
});


it("consumes both escape delimiters before hexadecimal-looking names and references", () => {
  expect(parseOplTags("name=Forest%20%Road%20%63,ref=FS%20%6300,oneway%3a%foot=-1")).toEqual({
    name: "Forest Road 63", ref: "FS 6300", "oneway:foot": "-1",
  });
  expect(parseOplTags("name=West%20%Cady%20%Ridge%20%Trail").name).toBe("West Cady Ridge Trail");
});

it("decodes Unicode scalar values and escaped punctuation exactly once", () => {
  expect(parseOplTags("name=Café%20%%1F3D4%%fe0f%,note=%a%%2C%%3d%%40%%25%20%25%")).toEqual({
    name: "Café 🏔️", note: "\n,=@%20%",
  });
  expect(parseOplTags("name=%0000e9%").name).toBe("é");
  expect(parseOplTags("name=Caf%C3%A9").name).toBe("CafÃA9");
});

it.each(["%", "%20", "%gg%", "%%", "%1234567%", "%110000%", "%d800%", "%DFFF%"])(
  "rejects malformed OPL escape %s", (value) => {
    expect(() => parseOplTags(`name=${value}`)).toThrow(/Invalid OPL/);
    expect(() => parseOplTags(`${value}=name`)).toThrow(/Invalid OPL/);
  },
);
