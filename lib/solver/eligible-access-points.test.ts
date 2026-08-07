import { describe, expect, it } from "vitest";
import type { AccessPointCandidate, GraphRepository } from "@/lib/graph";
import {
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
    populationWithinRadius: 0,
    localReliefM: 100,
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

  it("applies geometry, access policy, remoteness, and stable ranking once", async () => {
    const points = [
      point("lower-rank"),
      point("higher-rank", { knownConnectivity: 5 }),
      point("outside", { lon: 2 }),
      point("uncertain", { accessState: "unknown" }),
      point("populated", { populationWithinRadius: 100_000 }),
    ];
    const repository = {
      packId: "fixture",
      getAccessPointCandidates: async () => points,
    } as unknown as GraphRepository;
    const result = await listEligibleAccessPointCandidates({
      repository,
      accessFilter: { predicates: [AREA], coverage: AREA, summary: { mode: "drawn-area", label: "Drawn" } },
      includeUncertainAccess: false,
      accessPointRemoteness: ["remote"],
    });
    expect(result.all).toHaveLength(5);
    expect(result.eligible.map(({ id }) => id)).toEqual(["higher-rank", "lower-rank"]);
  });

  it("includes portal nodes just outside a named boundary without relaxing drawn or drive-time geometry", () => {
    const nearBoundaryPortal = point("portal", {
      lon: 1 + 10 / 111_195,
      trailComponentId: "trail:portal",
      reachableTrailKm: 10,
    });
    const namedFilter = {
      predicates: [AREA],
      coverage: AREA,
      summary: { mode: "named-region" as const, label: "Park", region: { id: "park", name: "Park" } },
    };
    expect(PORTAL_NAMED_REGION_TOLERANCE_M).toBe(25);
    expect(accessPointMatchesResolvedFilter(nearBoundaryPortal, namedFilter)).toBe(true);
    expect(accessPointMatchesResolvedFilter(
      { ...nearBoundaryPortal, lon: 1 + 30 / 111_195 },
      namedFilter,
    )).toBe(false);
    expect(accessPointMatchesResolvedFilter(nearBoundaryPortal, {
      ...namedFilter,
      summary: { mode: "drawn-area", label: "Drawn" },
    })).toBe(false);
    expect(accessPointMatchesResolvedFilter(nearBoundaryPortal, {
      predicates: [AREA, AREA],
      coverage: AREA,
      summary: {
        mode: "drive-time",
        label: "Drive",
        region: { id: "park", name: "Park" },
        driveTime: {
          minutes: 30,
          provider: "arcgis",
          resolvedAt: "2026-08-07T00:00:00.000Z",
          originLabel: "Origin",
        },
      },
    })).toBe(false);
  });
});
