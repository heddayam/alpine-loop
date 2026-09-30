import { describe, expect, it } from "vitest";
import type { AccessPointCandidate, GraphRepository } from "@/lib/graph";
import {
  accessPointCanStartClosedRoute,
  accessPointMatchesResolvedFilter,
  listEligibleAccessPointCandidates,
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
  it("queries the selected area and looks up an outside explicit start by identity", async () => {
    const calls: Parameters<GraphRepository["getAccessPointCandidates"]>[0][]=[];
    const repository={getAccessPointCandidates:async (query:typeof calls[number])=>{calls.push(query);return query.accessPointId ? [point(query.accessPointId,{lon:3})] : [point("inside")];}} as GraphRepository;
    const result=await listEligibleAccessPointCandidates({repository,accessFilter:{predicates:[AREA],coverage:{type:"Polygon",coordinates:[[[-4,-4],[4,-4],[4,4],[-4,4],[-4,-4]]]}},includeUncertainAccess:true,startAccessPointId:"outside"});
    expect(calls.map(call=>call.bbox)).toEqual([[-1,-1,1,1],[-4,-4,4,4]]);
    expect(calls[1]?.accessPointId).toBe("outside");
    expect(result.all.map(point=>point.id)).toEqual(["inside","outside"]);
    expect(result.eligible.map(point=>point.id)).toEqual(["inside"]);
  });

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

  it("applies geometry and requested access policy without a density veto", async () => {
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
    expect(result.eligible.map(({ id }) => id)).toEqual(["higher-rank", "built-up", "lower-rank"]);
  });

  it("keeps starts whose closed-route reachability was never measured", () => {
    expect(accessPointCanStartClosedRoute({ canReachCycle: true })).toBe(true);
    expect(accessPointCanStartClosedRoute({ canReachCycle: undefined })).toBe(true);
    expect(accessPointCanStartClosedRoute({})).toBe(true);
    expect(accessPointCanStartClosedRoute({ canReachCycle: false })).toBe(false);
  });

  it("excludes starts that cannot close a loop and reports how many were dropped", async () => {
    const points = [
      point("loops", { canReachCycle: true }),
      point("dead-end", { canReachCycle: false }),
      point("unmeasured", { canReachCycle: undefined }),
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
    expect(result.matchedFilters.map(({ id }) => id).sort()).toEqual(["built-up-dead-end", "dead-end", "loops", "unmeasured"]);
    expect(result.noCycleExcluded).toBe(2);
  });

  it("uses actual named membership, including outside approaches and holes, while drawn/drive geometry stays exact", () => {
    const member = point("portal", { lon: 3, regionIds: ["selected", "other"] });
    const namedFilter = {
      namedRegionPredicateIndex: 0,
      namedRegionIds: ["selected"],
      predicates: [AREA],
      coverage: AREA,
    };
    expect(accessPointMatchesResolvedFilter(member, namedFilter)).toBe(true);
    expect(accessPointMatchesResolvedFilter(point("wrong-circle", { regionIds: ["neighbor"] }), namedFilter)).toBe(false);
    expect(accessPointMatchesResolvedFilter(point("unrecorded"), namedFilter)).toBe(false);
    expect(accessPointMatchesResolvedFilter(member, { ...namedFilter, namedRegionIds: ["missing", "other"] })).toBe(true);
    expect(accessPointMatchesResolvedFilter(member, { ...namedFilter, namedRegionIds: undefined })).toBe(false);
    expect(accessPointMatchesResolvedFilter(member, {
      predicates: [AREA, AREA],
      namedRegionPredicateIndex: 1,
      namedRegionIds: ["selected"],
      coverage: AREA,
    })).toBe(false);
    const hole = { type: "Polygon" as const, coordinates: [AREA.coordinates[0], [[-0.1,-0.1],[0.1,-0.1],[0.1,0.1],[-0.1,0.1],[-0.1,-0.1]]] };
    const holeMember = { ...member, lon: 0 };
    expect(accessPointMatchesResolvedFilter(holeMember, { ...namedFilter, predicates: [hole] })).toBe(true);
    expect(accessPointMatchesResolvedFilter(holeMember, { predicates: [hole], coverage: AREA })).toBe(false);
    expect(accessPointMatchesResolvedFilter(holeMember, { ...namedFilter, predicates: [hole, hole], namedRegionPredicateIndex: 1 })).toBe(false);
    expect(accessPointMatchesResolvedFilter({ ...holeMember, lon: 1 }, { predicates: [AREA], coverage: AREA })).toBe(true);
  });

  it("does not bound named membership by its display polygon and requests the selected profile", async () => {
    const calls: Parameters<GraphRepository["getAccessPointCandidates"]>[0][]=[];
    const coverage = { type: "Polygon" as const, coordinates: [[[-4,-4],[4,-4],[4,4],[-4,4],[-4,-4]]] };
    const repository = { getAccessPointCandidates: async (query:typeof calls[number]) => {
      calls.push(query); return [point("outside-member", { lon: 3, regionIds: ["selected"] }), point("inside-neighbor", { regionIds: ["neighbor"] })];
    } } as GraphRepository;
    const result = await listEligibleAccessPointCandidates({ repository, includeUncertainAccess: false,
      accessFilter: { predicates: [AREA], namedRegionPredicateIndex: 0, namedRegionIds: ["selected"], coverage } });
    expect(calls.map(call => [call.bbox, call.includeUncertainAccess])).toEqual([[[-4,-4,4,4], false]]);
    expect(result.eligible.map(point => point.id)).toEqual(["outside-member"]);
  });

  it("uses null cycle hints from the requested profile without exact-distance pruning", async () => {
    const candidates = [point("unknown-loop", { knownMinimumStemMeters: null, inclusiveMinimumStemMeters: 0, canReachCycle: true }),
      point("long-stem", { knownMinimumStemMeters: 20_000, inclusiveMinimumStemMeters: 20_000, canReachCycle: true })];
    const repository = { getAccessPointCandidates: async () => candidates } as unknown as GraphRepository;
    const options = { repository, accessFilter: { predicates: [AREA], coverage: AREA } };
    const known = await listEligibleAccessPointCandidates({ ...options, includeUncertainAccess: false });
    expect(known.eligible.map(point => point.id)).toEqual(["long-stem"]);
    expect(known.noCycleExcluded).toBe(1);
    expect((await listEligibleAccessPointCandidates({ ...options, includeUncertainAccess: true })).eligible).toHaveLength(2);
  });

  it("clips only the fetch bounds to a viewport without changing named membership", async () => {
    const calls: Parameters<GraphRepository["getAccessPointCandidates"]>[0][]=[];
    const repository = { getAccessPointCandidates: async (query:typeof calls[number]) => {
      calls.push(query); return [point("selected", { lon:0.5, regionIds:["selected"] })];
    } } as GraphRepository;
    const result = await listEligibleAccessPointCandidates({ repository,includeUncertainAccess:true,viewportBbox:[0,-0.5,2,0.5],
      accessFilter:{predicates:[AREA,AREA],namedRegionPredicateIndex:1,namedRegionIds:["selected"],coverage:AREA} });
    expect(calls[0].bbox).toEqual([0,-0.5,1,0.5]);
    expect(result.eligible.map(point=>point.id)).toEqual(["selected"]);
  });

  it("uses an inclusive explicit-start fallback only for ineligible-start diagnostics", async () => {
    const calls: Parameters<GraphRepository["getAccessPointCandidates"]>[0][]=[];
    const repository = { getAccessPointCandidates: async (query:typeof calls[number]) => {
      calls.push(query); return query.includeUncertainAccess ? [point("uncertain", { accessState: "unknown" })] : [];
    } } as GraphRepository;
    const result = await listEligibleAccessPointCandidates({ repository, accessFilter: { predicates: [AREA], coverage: AREA }, includeUncertainAccess: false, startAccessPointId: "uncertain" });
    expect(calls.map(call => call.includeUncertainAccess)).toEqual([false, false, true]);
    expect(result.all.map(point => point.id)).toEqual(["uncertain"]);
    expect(result.matchedFilters).toEqual([]);
    expect(result.eligible).toEqual([]);
    expect(result.noCycleExcluded).toBe(0);
  });
});
