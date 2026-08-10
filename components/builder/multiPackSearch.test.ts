import { describe, expect, it } from "vitest";
import type { GeneratedClosedRouteV3, GenerateClosedRoutesResponseV3 } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import {
  combineAreaGeometries,
  combineQuickResponses,
  namespaceResponse,
  reconcileSelectedPackIds,
  unionBounds,
} from "./multiPackSearch";

function route(id: string): GeneratedClosedRouteV3 {
  const offset = [...id].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 10_000, 7) / 1_000_000;
  return {
    id,
    geometry: { type: "LineString", coordinates: [[-122.2, 37.1], [-122.1 + offset, 37.2], [-122.2, 37.1]] },
    startAccessPoint: { id: `start-${id}`, name: id, lon: -122.2, lat: 37.1, accessState: "public", confidence: "high" },
    distanceMeters: 1_000,
    elevationGainMeters: 100,
    elevationLossMeters: 100,
    minimumElevationMeters: 10,
    maximumElevationMeters: 110,
    steepestSustainedGradePct: 4,
    trailNames: ["Test Trail"],
    trailSegments: [{
      id: `segment-${id}`,
      geometry: { type: "LineString", coordinates: [[-122.2, 37.1], [-122.1, 37.2]] },
      name: "Test Trail",
      distanceMeters: 1_000,
      startDistanceMeters: 0,
      endDistanceMeters: 1_000,
      accessState: "public",
      condition: { highway: "path" },
      sourceIds: ["osm"],
    }],
    warnings: [],
    source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["osm"] },
    topology: {
      kind: "simple-loop",
      cycleCount: 1,
      cycleBlockCount: 1,
      repeatedTrailDistanceMeters: 0,
      repeatedTrailFraction: 0,
      sharedStemDistanceMeters: 0,
      connectorCount: 0,
    },
  };
}

function response(packId: string, exactIds: string[], closeIds: string[]): GenerateClosedRoutesResponseV3 {
  return {
    version: 3,
    requestId: `request-${packId}`,
    pack: { id: packId, schemaVersion: "5", dataVersion: `data-${packId}`, builtAt: "2026-08-01T00:00:00Z" },
    requested: 10,
    resolvedAccessFilter: { mode: "drawn-area", label: `${packId} area` },
    exact: exactIds.map(route),
    nearMisses: closeIds.map((id) => ({
      ...route(id),
      violations: [{ constraint: "distance", value: 1, min: 2, max: 3, delta: 1, normalizedDelta: 0.5 }],
    })),
    diagnostics: {
      elapsedMs: 10,
      expandedStates: 11,
      candidateCount: 12,
      eligibleAccessPointCount: 13,
      searchedAccessPointCount: 14,
      graphQueryCount: 15,
      maximumLoadedDirectedEdges: 16,
      exhausted: true,
      truncationReasons: ["shared-truncation", `${packId}-truncation`],
      shortfallReasons: ["shared-shortfall", `${packId}-shortfall`],
      noCycleAccessPointCount: 17,
      feasibleAccessPointCount: 18,
      attachmentGroupCount: 19,
      probedAttachmentGroupCount: 20,
      deeplySearchedAttachmentGroupCount: 21,
      loadedTopologyNetworkCount: 22,
      cycleBlockCount: 23,
      cyclePrimitiveCount: 24,
      composedCandidateCount: 25,
      repairedCandidateCount: 26,
      directedValidationRejectionCount: 27,
      expandedAssemblyStates: 28,
      timeToFirstExactMs: 30,
      hardTruncationReasons: ["shared-hard", `${packId}-hard`],
      nonBudgetShortfallReasons: ["shared-non-budget", `${packId}-non-budget`],
    },
  };
}

describe("multi-pack search helpers", () => {
  it("unions one or more bounds", () => {
    expect(unionBounds([[-122, 37, -121, 38], [-123, 36, -121.5, 39]])).toEqual([-123, 36, -121, 39]);
    expect(unionBounds([[-122, 37, -121, 38]])).toEqual([-122, 37, -121, 38]);
    expect(() => unionBounds([])).toThrow("At least one bounds");
  });

  it("combines polygon coordinates without replacing them with bounding boxes", () => {
    const polygon: AreaGeometry = {
      type: "Polygon",
      coordinates: [[[-123, 37], [-122.8, 37.4], [-122.6, 37], [-123, 37]]],
    };
    const multiPolygon: AreaGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[-122, 36], [-121.8, 36.2], [-121.6, 36], [-122, 36]]],
        [[[-121.5, 35], [-121.3, 35.2], [-121.1, 35], [-121.5, 35]]],
      ],
    };

    expect(combineAreaGeometries([])).toBeUndefined();
    expect(combineAreaGeometries([polygon])).toEqual(polygon);
    expect(combineAreaGeometries([polygon, multiPolygon])).toEqual({
      type: "MultiPolygon",
      coordinates: [polygon.coordinates, ...multiPolygon.coordinates],
    });
  });

  it("namespaces route and trail-segment ids while preserving the response", () => {
    const original = response("north", ["same"], ["close"]);
    const namespaced = namespaceResponse("north", original);

    expect(namespaced.exact[0]?.id).toBe("north::same");
    expect(namespaced.exact[0]?.trailSegments?.[0]?.id).toBe("north::segment-same");
    expect(namespaced.nearMisses[0]?.id).toBe("north::close");
    expect(namespaced.nearMisses[0]?.trailSegments?.[0]?.id).toBe("north::segment-close");
    expect(namespaced.requestId).toBe(original.requestId);
    expect(original.exact[0]?.id).toBe("same");
  });

  it("round-robins exact and close matches independently and aggregates diagnostics", () => {
    const north = response("north", ["e1", "e2", "e3"], ["c1", "c2", "c3"]);
    const south = response("south", ["s1", "s2"], ["d1", "d2"]);
    south.diagnostics.elapsedMs = 5;
    south.diagnostics.maximumLoadedDirectedEdges = 100;
    south.diagnostics.exhausted = false;
    south.diagnostics.timeToFirstExactMs = 8;
    const combined = combineQuickResponses([
      { packLabel: "North Country", response: north },
      { packLabel: "South Country", response: south },
    ], 4);

    expect(combined.requested).toBe(4);
    expect(combined.resolvedAccessFilter).toEqual({ mode: "drawn-area", label: "Multiple regions: North Country, South Country" });
    expect(combined.exact.map(({ id }) => id)).toEqual(["north::e1", "south::s1", "north::e2", "south::s2"]);
    expect(combined.nearMisses.map(({ id }) => id)).toEqual(["north::c1", "south::d1", "north::c2", "south::d2"]);
    expect(combined.diagnostics).toMatchObject({
      elapsedMs: 15,
      expandedStates: 22,
      candidateCount: 24,
      maximumLoadedDirectedEdges: 100,
      exhausted: false,
      timeToFirstExactMs: 8,
      truncationReasons: ["shared-truncation", "north-truncation", "south-truncation"],
      shortfallReasons: ["shared-shortfall", "north-shortfall", "south-shortfall"],
      hardTruncationReasons: ["shared-hard", "north-hard", "south-hard"],
      nonBudgetShortfallReasons: ["shared-non-budget", "north-non-budget", "south-non-budget"],
      expandedAssemblyStates: 56,
    });
    expect(combineQuickResponses([
      { packLabel: "North Country", response: north },
      { packLabel: "South Country", response: south },
    ], 4).requestId).toBe(combined.requestId);
    expect(combined.requestId).not.toContain(north.requestId);
  });

  it("deduplicates overlapping route geometry across packs and match groups", () => {
    const north = response("north", ["north-exact"], []);
    const south = response("south", ["south-exact"], ["south-close"]);
    south.exact[0]!.geometry = north.exact[0]!.geometry;
    south.nearMisses[0]!.geometry = north.exact[0]!.geometry;

    const combined = combineQuickResponses([
      { packLabel: "North Country", response: north },
      { packLabel: "South Country", response: south },
    ], 10);

    expect(combined.exact.map(({ id }) => id)).toEqual(["north::north-exact"]);
    expect(combined.nearMisses).toEqual([]);
  });

  it("keeps a single response valid while still guaranteeing collision-safe ids", () => {
    const original = response("north", ["exact"], ["close"]);
    original.diagnostics.timeToFirstExactMs = undefined;
    const combined = combineQuickResponses([{ packLabel: "North Country", response: original }], 10);

    expect(combined.requested).toBe(10);
    expect(combined.resolvedAccessFilter).toEqual(original.resolvedAccessFilter);
    expect(combined.exact[0]?.id).toBe("north::exact");
    expect(combined.diagnostics.timeToFirstExactMs).toBeUndefined();
    expect(combined.diagnostics).toEqual(original.diagnostics);
  });

  it("reconciles URL candidates in catalog order with an available fallback", () => {
    expect(reconcileSelectedPackIds(["south", "missing", "north", "south"], ["north", "central", "south"])).toEqual(["north", "south"]);
    expect(reconcileSelectedPackIds(["missing"], ["north", "south"], "south")).toEqual(["south"]);
    expect(reconcileSelectedPackIds([], ["north", "south"], "missing")).toEqual(["north"]);
    expect(reconcileSelectedPackIds([], ["north", "south"], "north", true)).toEqual([]);
    expect(() => reconcileSelectedPackIds([], [])).toThrow("At least one available pack");
  });
});
