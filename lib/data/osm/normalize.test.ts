import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyOsmWay, normalizeOsmFeatures, osmAccessState, readOsmGeoJsonSequence } from "./normalize";

const fixturePath = path.resolve("data/fixtures/source/osm/hiking.geojsonseq");

describe("OSM hiking topology normalization", () => {
  it("normalizes trail and road context, stable intersections, portal evidence and direction", async () => {
    const topology = normalizeOsmFeatures(await readOsmGeoJsonSequence(fixturePath), "osm-fixture");

    expect(topology.ways).toHaveLength(3);
    expect(topology.rejectedWayCount).toBe(0);
    expect(topology.accessPoints).toEqual([]);
    expect(topology.portalEvidence).toHaveLength(2);
    expect(topology.ways[0]).toMatchObject({ accessState: "public", bidirectional: true });
    expect(topology.ways[1]).toMatchObject({ accessState: "private", bidirectional: false });
    expect(topology.ways[1].coordinates[0]).toEqual([-122.17, 37.19]);
    expect(topology.ways.map(({ edgeClass }) => edgeClass)).toEqual(["trail", "trail", "street"]);
    expect(topology.portalEvidence?.map(({ accessState }) => accessState)).toEqual(["public", "unknown"]);
    expect(new Set(topology.nodes.map(({ id }) => id)).size).toBe(topology.nodes.length);
  });

  it("defaults ambiguous access to unknown and retains explicit restrictions", () => {
    expect(osmAccessState({})).toBe("unknown");
    expect(osmAccessState({ access: "no" })).toBe("prohibited");
    expect(osmAccessState({ foot: "private", access: "yes" })).toBe("private");
  });

  it("classifies ways deterministically from road, pedestrian and motor-vehicle context", () => {
    expect(classifyOsmWay({ highway: "path" })).toBe("trail");
    expect(classifyOsmWay({ highway: "residential", name: "Main Street" })).toBe("street");
    expect(classifyOsmWay({ highway: "primary_link" })).toBe("street");
    expect(classifyOsmWay({ highway: "service", foot: "designated" })).toBe("trail");
    expect(classifyOsmWay({ highway: "residential", foot: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "unclassified", name: "Ridge Trail connector" })).toBe("trail");
    expect(classifyOsmWay({ highway: "footway" })).toBe("sidewalk");
    expect(classifyOsmWay({ highway: "footway", name: "Ridge Trail" })).toBe("trail");
    expect(classifyOsmWay({ highway: "footway", sac_scale: "hiking" })).toBe("trail");
    for (const footway of ["sidewalk", "crossing", "traffic_island", "access_aisle", "link"]) {
      expect(classifyOsmWay({ highway: "footway", footway })).toBe("sidewalk");
    }
    expect(classifyOsmWay({ highway: "service", service: "parking_aisle" })).toBe("service-road");
    expect(classifyOsmWay({ highway: "track" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", access: "private" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", motor_vehicle: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", vehicle: "designated" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", access: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", motor_vehicle: "yes", foot: "no" })).toBe("service-road");
    expect(classifyOsmWay({ highway: "construction" })).toBeNull();
  });

  it("collects point and way evidence with the evidence geometry intact", () => {
    const topology = normalizeOsmFeatures([
      {
        type: "Feature",
        id: "way/1",
        properties: { "@id": "way/1", highway: "secondary", name: "Summit Road" },
        geometry: { type: "LineString", coordinates: [[-122.2, 37.2], [-122.19, 37.2]] },
      },
      {
        type: "Feature",
        id: "way/2",
        properties: { "@id": "way/2", amenity: "parking", name: "Summit Lot" },
        geometry: { type: "LineString", coordinates: [[-122.2, 37.201], [-122.19, 37.201], [-122.2, 37.201]] },
      },
      {
        type: "Feature",
        id: "node/3",
        properties: { "@id": "node/3", information: "guidepost", name: "Junction" },
        geometry: { type: "Point", coordinates: [-122.195, 37.2] },
      },
      {
        type: "Feature",
        id: "node/4",
        properties: { "@id": "node/4", tourism: "information" },
        geometry: { type: "Point", coordinates: [-122.194, 37.2] },
      },
      {
        type: "Feature",
        id: "node/5",
        properties: { "@id": "node/5", information: "trailhead" },
        geometry: { type: "Point", coordinates: [-122.193, 37.2] },
      },
      {
        type: "Feature",
        id: "node/6",
        properties: { "@id": "node/6", barrier: "gate" },
        geometry: { type: "Point", coordinates: [-122.192, 37.2] },
      },
    ], "osm-fixture");

    expect(topology.accessPoints).toEqual([]);
    expect(topology.ways).toEqual([expect.objectContaining({ externalId: "way/1", edgeClass: "street" })]);
    expect(topology.portalEvidence?.map(({ kind }) => kind)).toEqual([
      "parking", "information", "information", "trailhead", "gate",
    ]);
    expect(topology.portalEvidence?.[0]).toMatchObject({
      externalId: "way/2",
      name: "Summit Lot",
      nodeIds: expect.arrayContaining([expect.stringMatching(/^osm-coordinate-/)]),
      coordinates: [[-122.2, 37.201], [-122.19, 37.201], [-122.2, 37.201]],
    });
    expect(topology.portalEvidence?.[4]).toMatchObject({
      externalId: "node/6",
      name: null,
      coordinates: [[-122.192, 37.2]],
    });
  });
});
