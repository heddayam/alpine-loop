import { describe, expect, it } from "vitest";
import type { GeneratedClosedRouteV3, GenerateClosedRoutesResponseV3 } from "@/lib/contracts";
import { collectQuickResults } from "./routeResults";

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

describe("route result collections", () => {
  it("namespaces route and trail-segment ids while preserving the response", () => {
    const original = response("north", ["same"], ["close"]);
    const namespaced = collectQuickResults([{ label: "North Country", response: original }], 10);

    expect(namespaced.exact[0]?.id).toBe("north::same");
    expect(namespaced.exact[0]?.trailSegments?.[0]?.id).toBe("north::segment-same");
    expect(namespaced.nearMisses[0]?.id).toBe("north::close");
    expect(namespaced.nearMisses[0]?.trailSegments?.[0]?.id).toBe("north::segment-close");
    expect(namespaced.searches[0]?.requestId).toBe(original.requestId);
    expect(namespaced.exact[0]?.regionLabel).toBe("North Country");
    expect(original.exact[0]?.id).toBe("same");
  });

  it("round-robins exact and close matches independently and preserves each search’s diagnostics", () => {
    const north = response("north", ["e1", "e2", "e3"], ["c1", "c2", "c3"]);
    const south = response("south", ["s1", "s2"], ["d1", "d2"]);
    south.diagnostics.elapsedMs = 5;
    south.diagnostics.maximumLoadedDirectedEdges = 100;
    south.diagnostics.exhausted = false;
    south.diagnostics.timeToFirstExactMs = 8;
    const combined = collectQuickResults([
      { label: "North Country", response: north },
      { label: "South Country", response: south },
    ], 4);

    expect(combined.requested).toBe(4);
    expect(combined.exact.map(({ id }) => id)).toEqual(["north::e1", "south::s1", "north::e2", "south::s2"]);
    expect(combined.nearMisses.map(({ id }) => id)).toEqual(["north::c1", "south::d1", "north::c2", "south::d2"]);
    expect(combined.searches).toEqual([
      { label: "North Country", requestId: north.requestId, pack: north.pack, resolvedAccessFilter: north.resolvedAccessFilter, diagnostics: north.diagnostics },
      { label: "South Country", requestId: south.requestId, pack: south.pack, resolvedAccessFilter: south.resolvedAccessFilter, diagnostics: south.diagnostics },
    ]);
  });

  it("deduplicates overlapping route geometry across packs and match groups", () => {
    const north = response("north", ["north-exact"], []);
    const south = response("south", ["south-exact"], ["south-close"]);
    south.exact[0]!.geometry = north.exact[0]!.geometry;
    south.nearMisses[0]!.geometry = north.exact[0]!.geometry;

    const combined = collectQuickResults([
      { label: "North Country", response: north },
      { label: "South Country", response: south },
    ], 10);

    expect(combined.exact.map(({ id }) => id)).toEqual(["north::north-exact"]);
    expect(combined.nearMisses).toEqual([]);
  });

});
