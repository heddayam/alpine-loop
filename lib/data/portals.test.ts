import { describe, expect, it } from "vitest";
import type { NormalizedAccessEvidence } from "./adapters";
import {
  applyOfficialEntranceOverlay,
  deriveTrailheadPortals,
  PORTAL_CLUSTER_DISTANCE_M,
  PORTAL_DERIVATION_VERSION,
  PORTAL_EVIDENCE_DISTANCE_M,
  stripPortalBuildContext,
} from "./portals";
import type {
  EdgeClass,
  NormalizedNode,
  NormalizedPortalEvidence,
  NormalizedTopology,
  NormalizedWay,
} from "./types";

const METERS_PER_LONGITUDE_DEGREE = 111_195;

function node(id: string, eastM: number, northM = 0): NormalizedNode {
  return {
    id,
    externalId: `node/${id}`,
    lon: eastM / METERS_PER_LONGITUDE_DEGREE,
    lat: northM / METERS_PER_LONGITUDE_DEGREE,
    elevationM: null,
    flags: [],
    sourceRefs: ["osm"],
  };
}

function way(
  id: string,
  nodeIds: string[],
  nodes: readonly NormalizedNode[],
  edgeClass: EdgeClass,
  accessState: NormalizedWay["accessState"] = "public",
  name: string | null = null,
): NormalizedWay {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  return {
    id,
    externalId: `way/${id}`,
    nodeIds,
    coordinates: nodeIds.map((nodeId) => {
      const item = byId.get(nodeId)!;
      return [item.lon, item.lat] as const;
    }),
    name,
    accessState,
    bidirectional: true,
    edgeClass,
    sourceRefs: ["osm"],
    flags: [],
  };
}

function evidence(
  id: string,
  kind: NormalizedPortalEvidence["kind"],
  coordinates: NormalizedPortalEvidence["coordinates"],
  nodeIds: string[] = [],
  name: string | null = null,
): NormalizedPortalEvidence {
  return {
    id,
    externalId: `${kind}/${id}`,
    kind,
    name,
    nodeIds,
    coordinates,
    accessState: "unknown",
    sourceRefs: [`osm-${kind}`],
  };
}

function topology(
  nodes: NormalizedNode[],
  ways: NormalizedWay[],
  portalEvidence: NormalizedPortalEvidence[] = [],
): NormalizedTopology {
  return {
    nodes,
    ways,
    accessPoints: [{
      id: "old-parking-row",
      externalId: "way/parking",
      nodeId: nodes[0]!.id,
      name: "OSM parking",
      kind: "parking",
      accessState: "unknown",
      confidence: "low",
      parkingEvidence: "osm:amenity=parking",
      sourceRefs: ["osm"],
    }],
    portalEvidence,
    rejectedWayCount: 0,
  };
}

describe("trailhead portal derivation", () => {
  it("uses strict, non-restrictive street intersections and replaces parking access rows", () => {
    const nodes = [
      node("public", 0), node("public-trail", 300),
      node("service", 1_000), node("service-trail", 1_300),
      node("private", 2_000), node("private-trail", 2_300),
      node("street-end", 0, 100), node("service-end", 1_000, 100), node("private-end", 2_000, 100),
    ];
    const ways = [
      way("public-trail", ["public", "public-trail"], nodes, "trail", "public", "Ridge Trail"),
      way("service-trail", ["service", "service-trail"], nodes, "trail"),
      way("private-trail", ["private", "private-trail"], nodes, "trail"),
      way("public-street", ["public", "street-end"], nodes, "street"),
      way("service-road", ["service", "service-end"], nodes, "service-road"),
      way("private-street", ["private", "private-end"], nodes, "street", "private"),
    ];

    const derived = deriveTrailheadPortals(topology(nodes, ways));

    expect(derived.accessPoints).toHaveLength(1);
    expect(derived.accessPoints[0]).toMatchObject({
      id: "portal:public",
      kind: "trailhead",
      nodeId: "public",
      name: "Ridge Trail trailhead",
      portalRoadClass: "street",
      accessState: "public",
    });
    expect(derived.accessPoints.some(({ kind }) => kind === "parking")).toBe(false);
  });

  it("creates a portal at the nearest trail node only when parking itself touches a street", () => {
    const nodes = [
      node("trail-a", 200), node("trail-b", 500),
      node("parking-road-node", 0), node("road-end", 0, 100),
      node("unconnected-parking", 1_000),
    ];
    const ways = [
      way("trail", ["trail-a", "trail-b"], nodes, "trail"),
      way("street", ["parking-road-node", "road-end"], nodes, "street"),
    ];
    const portalEvidence = [
      evidence("connected", "parking", [[nodes[2]!.lon, nodes[2]!.lat]], ["parking-road-node"]),
      evidence("not-road-connected", "parking", [[nodes[4]!.lon, nodes[4]!.lat]], ["unconnected-parking"]),
      evidence("named-map", "information", [[nodes[0]!.lon, nodes[0]!.lat]], [], "West Ridge Map"),
      evidence("trail-gate", "gate", [[nodes[0]!.lon, nodes[0]!.lat]]),
    ];

    const derived = deriveTrailheadPortals(topology(nodes, ways, portalEvidence));

    expect(derived.accessPoints).toHaveLength(1);
    expect(derived.accessPoints[0]).toMatchObject({
      nodeId: "trail-a",
      name: "West Ridge Map",
      confidence: "medium",
      parkingEvidence: "portal-evidence:parking/connected",
    });
    expect(derived.accessPoints[0]!.parkingDistanceM).toBeCloseTo(200, 0);
    expect(derived.accessPoints[0]!.sourceRefs).toEqual(["osm", "osm-gate", "osm-information", "osm-parking"]);
  });

  it("accepts a non-restrictive service road as parking access without minting a direct service-road portal", () => {
    const nodes = [
      node("trail-a", 200), node("trail-b", 500),
      node("parking-road-node", 0), node("road-end", 0, 100),
    ];
    const ways = [
      way("trail", ["trail-a", "trail-b"], nodes, "trail"),
      way("service", ["parking-road-node", "road-end"], nodes, "service-road"),
    ];
    const portalEvidence = [
      evidence("connected", "parking", [[nodes[2]!.lon, nodes[2]!.lat]], ["parking-road-node"]),
    ];

    const derived = deriveTrailheadPortals(topology(nodes, ways, portalEvidence));

    expect(PORTAL_DERIVATION_VERSION).toBe("portal-derivation-v2");
    expect(derived.accessPoints).toHaveLength(1);
    expect(derived.accessPoints[0]).toMatchObject({
      nodeId: "trail-a",
      parkingEvidence: "portal-evidence:parking/connected",
    });
  });

  it("clusters deterministically and selects the strongest-evidence representative", () => {
    expect(PORTAL_CLUSTER_DISTANCE_M).toBe(150);
    expect(PORTAL_EVIDENCE_DISTANCE_M).toBe(250);
    const nodes = [node("a", 0), node("a-tail", -300), node("b", 100), node("b-tail", 400), node("road", 50, 100)];
    const ways = [
      way("trail-a", ["a-tail", "a"], nodes, "trail"),
      way("trail-b", ["b", "b-tail"], nodes, "trail"),
      way("street", ["a", "b", "road"], nodes, "street"),
    ];
    const portalEvidence = [evidence("marked", "trailhead", [[nodes[1]!.lon + 600 / METERS_PER_LONGITUDE_DEGREE, 0]], [], "Marked Entrance")];

    const forward = deriveTrailheadPortals(topology(nodes, ways, portalEvidence)).accessPoints;
    const reverse = deriveTrailheadPortals(topology([...nodes].reverse(), [...ways].reverse(), [...portalEvidence].reverse())).accessPoints;

    expect(forward).toEqual(reverse);
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({ id: "portal:b", name: "Marked Entrance", confidence: "high" });
  });

  it("scores candidates by unique physical kilometres in their undirected trail component", () => {
    const nodes = [
      node("long-start", 0), node("long-mid", -250), node("long-end", -500),
      node("short-start", 100), node("short-end", 100, 50), node("road", 50, 100),
    ];
    const ways = [
      way("long-one", ["long-start", "long-mid", "long-end"], nodes, "trail"),
      // A duplicate reversed representation must not double physical length.
      way("long-duplicate", ["long-end", "long-mid", "long-start"], nodes, "trail"),
      way("short", ["short-start", "short-end"], nodes, "trail"),
      way("street", ["long-start", "short-start", "road"], nodes, "street"),
    ];

    const derived = deriveTrailheadPortals(topology(nodes, ways));

    expect(derived.accessPoints).toHaveLength(1);
    expect(derived.accessPoints[0]!.nodeId).toBe("long-start");
    expect(derived.accessPoints[0]!.trailComponentId).toBe("trail-component:long-end");
    expect(derived.accessPoints[0]!.reachableTrailKm).toBeCloseTo(0.5, 2);
  });

  it("prefers the useful trail component over stronger evidence on a short disconnected stub", () => {
    const nodes = [
      node("long-start", 0), node("long-end", -1_000),
      node("stub-start", 100), node("stub-end", 100, 20), node("road", 50, 100),
    ];
    const ways = [
      way("long", ["long-start", "long-end"], nodes, "trail"),
      way("stub", ["stub-start", "stub-end"], nodes, "trail"),
      way("street", ["long-start", "stub-start", "road"], nodes, "street"),
    ];
    const portalEvidence = [
      evidence("stub-marker", "trailhead", [[nodes[2]!.lon, nodes[2]!.lat]], [], "Stub marker"),
    ];

    const derived = deriveTrailheadPortals(topology(nodes, ways, portalEvidence));

    expect(derived.accessPoints).toHaveLength(1);
    expect(derived.accessPoints[0]).toMatchObject({ nodeId: "long-start" });
    expect(derived.accessPoints[0]!.reachableTrailKm).toBeCloseTo(1, 2);
  });

  it("derives conservative access from incident trail edges and rejects unclassified input", () => {
    const nodes = [node("start", 0), node("public-end", -300), node("private-end", 300), node("road", 0, 100)];
    const ways = [
      way("public", ["public-end", "start"], nodes, "trail", "public"),
      way("private", ["start", "private-end"], nodes, "trail", "private"),
      way("street", ["start", "road"], nodes, "street"),
    ];
    expect(deriveTrailheadPortals(topology(nodes, ways)).accessPoints[0]!.accessState).toBe("private");

    const legacyWays = ways.map((item) => ({ ...item, edgeClass: undefined }));
    expect(() => deriveTrailheadPortals(topology(nodes, legacyWays))).toThrow(/classified trail and road/);
  });

  it("removes build-only roads and their nodes while preserving walking connectors and portals", () => {
    const nodes = [node("start", 0), node("trail-end", -300), node("road-only", 0, 100)];
    const ways = [
      way("walking-service", ["trail-end", "start"], nodes, "trail"),
      way("road-context", ["start", "road-only"], nodes, "street"),
    ];
    const derived = deriveTrailheadPortals(topology(nodes, ways));
    const published = stripPortalBuildContext(derived);

    expect(published.ways.map(({ id }) => id)).toEqual(["walking-service"]);
    expect(published.nodes.map(({ id }) => id).sort()).toEqual(["start", "trail-end"]);
    expect(published.accessPoints).toEqual(derived.accessPoints);
    expect(published.portalEvidence).toEqual([]);
  });
});

describe("official entrance overlay", () => {
  function official(externalId: string, eastM: number, name: string): NormalizedAccessEvidence {
    return {
      sourceId: "official-entrances",
      externalId,
      lon: eastM / METERS_PER_LONGITUDE_DEGREE,
      lat: 0,
      name,
      accessState: "closed",
      confidence: "high",
    };
  }

  it("cannot create starts and only changes names/evidence on in-range existing portals", () => {
    const nodes = [node("start", 0), node("trail-end", -300), node("road", 0, 100)];
    const ways = [
      way("trail", ["trail-end", "start"], nodes, "trail", "public"),
      way("street", ["start", "road"], nodes, "street"),
    ];
    const empty = topology(nodes, ways);
    empty.accessPoints = [];
    expect(applyOfficialEntranceOverlay(empty, [official("near", 1, "Official Entrance")]).accessPoints).toEqual([]);

    const derived = deriveTrailheadPortals(topology(nodes, ways));
    const overlaid = applyOfficialEntranceOverlay(derived, [
      official("far", 1_000, "Far Entrance"),
      official("near", 20, "Official Entrance"),
    ]);

    expect(overlaid.accessPoints).toHaveLength(derived.accessPoints.length);
    expect(overlaid.accessPoints[0]).toMatchObject({
      id: derived.accessPoints[0]!.id,
      nodeId: derived.accessPoints[0]!.nodeId,
      name: "Official Entrance",
      accessState: "public",
      confidence: "high",
    });
    expect(overlaid.accessPoints[0]!.sourceRefs).toEqual(["official-entrances", "osm"]);
  });

  it("breaks equal-distance overlay ties by stable portal ID regardless of input order", () => {
    const nodes = [node("a", -100), node("a-end", -400), node("b", 100), node("b-end", 400), node("road-a", -100, 100), node("road-b", 100, 100)];
    const ways = [
      way("trail-a", ["a-end", "a"], nodes, "trail"),
      way("trail-b", ["b", "b-end"], nodes, "trail"),
      way("street", ["road-a", "a", "b", "road-b"], nodes, "street"),
    ];
    const derived = deriveTrailheadPortals(topology(nodes, ways));
    // Keep both portals for the overlay tie test rather than the derivation cluster.
    derived.accessPoints = [
      { ...derived.accessPoints[0]!, id: "portal:a", nodeId: "a", name: "A" },
      { ...derived.accessPoints[0]!, id: "portal:b", nodeId: "b", name: "B" },
    ];
    const entrance = official("center", 0, "Center Entrance");
    const overlaid = applyOfficialEntranceOverlay(derived, [entrance]);

    expect(overlaid.accessPoints.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "portal:a", name: "Center Entrance" },
      { id: "portal:b", name: "B" },
    ]);
  });
});
