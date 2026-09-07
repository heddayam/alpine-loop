import { describe, expect, it } from "vitest";
import type { AccessPointCandidate, GraphRepository } from "@/lib/graph";
import {
  accessPointCanStartClosedRoute,
  accessPointMatchesResolvedFilter,
  listEligibleAccessPointCandidates,
  PORTAL_NAMED_REGION_TOLERANCE_M,
  rankAccessPointCandidates,
} from "./eligible-access-points";

const AREA = {
  type: "Polygon" as const,
  coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
};

function point(id: string, patch: Partial<AccessPointCandidate> = {}): AccessPointCandidate {
  return {
    id,
    nodeId: id,
    name: id,
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: null,
    nearbyBuildingCount: 0,
    sourceIds: ["fixture"],
    lon: 0,
    lat: 0,
    knownConnectivity: 1,
    inclusiveConnectivity: 1,
    knownOutDegree: 1,
    inclusiveOutDegree: 1,
    ...patch,
  };
}

describe("eligible access-point enumeration", () => {
  it("ranks schema-6 portals by trail reach and evidence, not public/unknown connectivity", () => {
    const smallerPublicGraph = point("public", {
      reachableTrailKm: 2,
      trailComponentId: "trail:public",
      portalRoadClass: "street",
      parkingDistanceM: 10,
      knownConnectivity: 10_000,
    });
    const largerUnknownGraph = point("unknown", {
      reachableTrailKm: 25,
      trailComponentId: "trail:unknown",
      portalRoadClass: "street",
      parkingDistanceM: null,
      knownConnectivity: 0,
    });
    expect(rankAccessPointCandidates(smallerPublicGraph, largerUnknownGraph, false)).toBeGreaterThan(0);
    expect(rankAccessPointCandidates(smallerPublicGraph, largerUnknownGraph, true)).toBeGreaterThan(0);
  });

  it("applies geometry, access policy, buildings, and stable ranking once", async () => {
    const points = [
      point("lower-rank"),
      point("higher-rank", { knownConnectivity: 5 }),
      point("outside", { lon: 2 }),
      point("uncertain", { accessState: "unknown" }),
      point("built-up", { nearbyBuildingCount: 500 }),
    ];
    const repository = {
      packId: "fixture",
      getAccessPointCandidates: async () => points,
    } as unknown as GraphRepository;
    const result = await listEligibleAccessPointCandidates({
      repository,
      accessFilter: { predicates: [AREA], coverage: AREA },
      includeUncertainAccess: false,
    });
    expect(result.all).toHaveLength(5);
    expect(result.eligible.map(({ id }) => id)).toEqual(["higher-rank", "lower-rank"]);
  });

  it("keeps starts whose closed-route reachability was never measured", () => {
    expect(accessPointCanStartClosedRoute({ canReachCycle: true })).toBe(true);
    expect(accessPointCanStartClosedRoute({ canReachCycle: null })).toBe(true);
    expect(accessPointCanStartClosedRoute({})).toBe(true);
    expect(accessPointCanStartClosedRoute({ canReachCycle: false })).toBe(false);
  });

  it("excludes starts that cannot close a loop and reports how many were dropped", async () => {
    const points = [
      point("loops", { canReachCycle: true }),
      point("dead-end", { canReachCycle: false }),
      point("unmeasured", { canReachCycle: null }),
      // Dropped for buildings, so it must not be counted as a no-cycle exclusion.
      point("built-up-dead-end", { nearbyBuildingCount: 500, canReachCycle: false }),
    ];
    const repository = {
      packId: "fixture",
      getAccessPointCandidates: async () => points,
    } as unknown as GraphRepository;
    const result = await listEligibleAccessPointCandidates({
      repository,
      accessFilter: { predicates: [AREA], coverage: AREA },
      includeUncertainAccess: false,
    });
    expect(result.eligible.map(({ id }) => id).sort()).toEqual(["loops", "unmeasured"]);
    expect(result.matchedFilters.map(({ id }) => id).sort()).toEqual(["dead-end", "loops", "unmeasured"]);
    expect(result.noCycleExcluded).toBe(1);
  });

  it("includes trail portals in the named-region approach band without relaxing drawn or drive-time geometry", () => {
    const nearBoundaryPortal = point("portal", {
      lon: 1 + 499 / 111_195,
      trailComponentId: "trail:portal",
      reachableTrailKm: 10,
    });
    const namedFilter = {
      namedRegionPredicateIndex: 0,
      predicates: [AREA],
      coverage: AREA,
    };
    expect(PORTAL_NAMED_REGION_TOLERANCE_M).toBe(500);
    expect(accessPointMatchesResolvedFilter(nearBoundaryPortal, namedFilter)).toBe(true);
    expect(accessPointMatchesResolvedFilter(
      { ...nearBoundaryPortal, lon: 1 + 501 / 111_195 },
      namedFilter,
    )).toBe(false);
    expect(accessPointMatchesResolvedFilter(
      { ...nearBoundaryPortal, trailComponentId: undefined },
      namedFilter,
    )).toBe(false);
    expect(accessPointMatchesResolvedFilter(nearBoundaryPortal, {
      ...namedFilter,
      namedRegionPredicateIndex: undefined,
    })).toBe(false);
    expect(accessPointMatchesResolvedFilter(nearBoundaryPortal, {
      predicates: [AREA, AREA],
      namedRegionPredicateIndex: 1,
      coverage: AREA,
    })).toBe(false);
  });
});
