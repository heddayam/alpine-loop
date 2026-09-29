import { describe, expect, it } from "vitest";
import type { AreaGeometry } from "../area-geometry";
import { compiledEdgesForSegment } from "../compiled-edges";
import { distanceMeters } from "../metrics";
import { normalizeOsmOpl } from "../osm/opl";
import type { NormalizedAccessPoint, NormalizedTopology } from "../types";
import { openProgressiveGraphStore } from "./store";

// Reduced local representations from the pinned WA 260801 source: entrance IDs,
// coordinates and tags are retained; long trails/roads omit intermediate nodes.
const top = `n4270728646 x-121.0788053 y47.8780535
n3761092325 Thighway=turning_circle x-121.0770096 y47.8812989
n3761092329 Thighway=trailhead,name=Top%20%Lake%20%Trailhead x-121.0771895 y47.881442
n3761092328 x-121.1532731 y47.8800167
w428036699 Thighway=track,ref=FR%20%6701-520,surface=gravel Nn4270728646,n3761092325
w1356527414 Thighway=path,foot=designated,name=Top%20%Lake%20%Trail Nn3761092325,n3761092329,n3761092328`;
const heather = `n47010713 x-121.0331753 y47.8759179
n3835171612 x-121.0752954 y47.8663592
n3835171557 x-121.0756526 y47.8662242
n3835171701 x-121.1252335 y47.8587991
n3835171595 x-121.0752717 y47.8663322
w5847190 Thighway=track,name=Heather%20%Lake%20%Trailhead%20%Road Nn47010713,n3835171612
w380176708 Thighway=path,foot=designated,name=Heather%20%Lake%20%Trail Nn3835171557,n3835171701
w380176709 Tamenity=parking,name=Heather%20%Lake%20%Trailhead Nn3835171612,n3835171557,n3835171595,n3835171612`;
const coverage: AreaGeometry = { type: "Polygon", coordinates: [[[-123,47],[-120,47],[-120,49],[-123,49],[-123,47]]] };

async function derive(opl: string, adjust?: (topology: NormalizedTopology) => void, omitPhysicalId?: string) {
  const topology = normalizeOsmOpl(opl, "fixture");
  adjust?.(topology);
  const store = openProgressiveGraphStore({ stagingPath: ":memory:", buildIdentity: "track-approaches" });
  try {
    store.transaction(() => {
      topology.nodes.forEach(node => store.putNode(node));
      topology.ways.forEach(way => {
        store.putWay(way);
        for (let index = 0; index < way.nodeIds.length - 1; index++) {
          if (`${way.id}:${index}` === omitPhysicalId) continue;
          const geometry = way.coordinates.slice(index, index + 2);
          const lengthM = distanceMeters(geometry[0]!, geometry[1]!);
          compiledEdgesForSegment(way, index, geometry, { lengthM, gainM: 0, lossM: 0, maxElevationM: 0, maxSustainedGradePct: 0,
            elevationProfile: [{ distanceMeters: 0, elevationMeters: 0 }, { distanceMeters: lengthM, elevationMeters: 0 }] })
            .forEach(edge => store.putEdge(edge));
        }
      });
      topology.portalEvidence?.forEach(evidence => store.putPortalEvidence(evidence));
    });
    const originalEdges = store.database.prepare("SELECT id,record FROM edges ORDER BY id").all();
    await store.derivePortals(coverage);
    const points = store.database.prepare("SELECT record FROM derived_portals ORDER BY id").all()
      .map(row => JSON.parse(String(row.record)) as NormalizedAccessPoint);
    return { points, topology, originalEdges, edges: store.database.prepare("SELECT id,record FROM edges ORDER BY id").all() };
  } finally { store.close(); }
}

function detachTrack(topology: NormalizedTopology) {
  const way = topology.ways.find(way => way.flags.includes("osm-highway:track"))!;
  const old = topology.nodes.find(node => node.id === way.nodeIds.at(-1))!;
  const node = { ...old, id: "unrelated", externalId: "node/unrelated", lon: old.lon + 0.00001 };
  topology.nodes.push(node);
  way.nodeIds[way.nodeIds.length - 1] = node.id;
  way.coordinates[way.coordinates.length - 1] = [node.lon, node.lat];
}

describe("explicit hiking starts reached by walking tracks", () => {
  it("keeps the mapped Top Lake trailhead 20.8m along its path from the track junction", async () => {
    const { points, topology, originalEdges, edges } = await derive(top);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ nodeId: "osm-node-3761092329", name: "Top Lake Trailhead", accessState: "public", confidence: "high", portalRoadClass: "service-road" });
    expect(topology.ways.find(way => way.id === "osm-way-428036699")?.edgeClass).toBe("trail");
    expect(edges).toEqual(originalEdges);
  });

  it("retains support for a tagged trailhead directly on the track/path junction", async () => {
    const { points } = await derive(top, topology => {
      const evidence = topology.portalEvidence![0]!;
      const junction = topology.nodes.find(node => node.id === "osm-node-3761092325")!;
      Object.assign(evidence, { nodeIds: [junction.id], externalId: junction.externalId, coordinates: [[junction.lon, junction.lat]] });
    });
    expect(points.map(point => point.nodeId)).toEqual(["osm-node-3761092325"]);
  });

  it("uses the hiking vertex of Heather Lake parking, without creating a connector across the lot", async () => {
    const { points, originalEdges, edges } = await derive(heather);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ nodeId: "osm-node-3835171557", accessState: "public", parkingEvidence: "portal-evidence:way/380176709", parkingDistanceM: 0, portalRoadClass: "service-road" });
    expect(edges).toEqual(originalEdges);
  });

  it.each(["track", "path", "evidence"] as const)("does not add a mapped trailhead through restricted %s", async kind => {
    const { points } = await derive(top, topology => {
      if (kind === "evidence") topology.portalEvidence![0]!.accessState = "private";
      else topology.ways.find(way => way.flags.includes(`osm-highway:${kind}`))!.accessState = "prohibited";
    });
    expect(points).toEqual([]);
  });

  it.each(["track", "path", "evidence"] as const)("does not add a parking start through restricted %s", async kind => {
    const { points } = await derive(heather, topology => {
      if (kind === "evidence") topology.portalEvidence![0]!.accessState = "private";
      else topology.ways.find(way => way.flags.includes(`osm-highway:${kind}`))!.accessState = "prohibited";
    });
    expect(points).toEqual([]);
  });

  it.each([top, heather])("requires a source connection, not a nearby unrelated track", async opl => {
    expect((await derive(opl, detachTrack)).points).toEqual([]);
  });

  it("does not snap track-side parking to an unrelated nearby hiking path", async () => {
    const { points } = await derive(heather, topology => {
      const evidence = topology.portalEvidence![0]!;
      const index = evidence.nodeIds.indexOf("osm-node-3835171557");
      const original = topology.nodes.find(node => node.id === evidence.nodeIds[index])!;
      const node = { ...original, id: "parking-vertex", externalId: "node/parking-vertex", lon: original.lon + 0.00001 };
      topology.nodes.push(node);
      evidence.nodeIds[index] = node.id;
      evidence.coordinates[index] = [node.lon, node.lat];
    });
    expect(points).toEqual([]);
  });

  it("does not promote an unmarked track/path junction", async () => {
    expect((await derive(top, topology => { topology.portalEvidence = []; })).points).toEqual([]);
  });

  it("does not traverse a pruned segment to find a track approach", async () => {
    expect((await derive(top, undefined, "osm-way-1356527414:0")).points).toEqual([]);
  });

  it("bounds the approach along the mapped path rather than straight-line distance", async () => {
    const { points } = await derive(top, topology => {
      const way = topology.ways.find(way => way.id === "osm-way-1356527414")!;
      const node = { ...topology.nodes[0]!, id: "detour", externalId: "node/detour", lon: -121.09, lat: 47.885 };
      topology.nodes.push(node);
      way.nodeIds.splice(1, 0, node.id);
      way.coordinates.splice(1, 0, [node.lon, node.lat]);
    });
    expect(points).toEqual([]);
  });
});
