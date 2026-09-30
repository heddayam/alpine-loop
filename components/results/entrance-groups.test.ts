import { describe, expect, it } from "vitest";
import { entranceRouteGroups } from "./entrance-groups";

function route(id: string, entrance: string, family?: string, loop?: string) {
  return { id, physicalLoopId: loop, startAccessPoint: {
    id: entrance, name: entrance, lon: -121, lat: 47,
    accessState: "public" as const, confidence: "high" as const, entranceFamilyId: family,
  } };
}

describe("proven alternate entrance route groups", () => {
  it("groups equal families and physical loops without removing or renumbering any candidate", () => {
    const routes = [route("a", "entrance-a", "family", "loop"), route("other", "other", "family", "other-loop"), route("b", "entrance-b", "family", "loop")];
    const groups = entranceRouteGroups(routes, 10);
    expect(groups.map(({ entries }) => entries.map(({ route, index }) => [route.id, index]))).toEqual([[["a", 10], ["b", 12]], [["other", 11]]]);
    expect(groups.flatMap(({ entries }) => entries.map(({ route }) => route))).toHaveLength(routes.length);
    expect(groups[0]!.entries[1]!.route).toBe(routes[2]);
  });

  it("leaves each same-entrance candidate as a separate representative", () => {
    const groups = entranceRouteGroups([
      route("a1", "a", "family", "loop"), route("a2", "a", "family", "loop"),
      route("b1", "b", "family", "loop"), route("b2", "b", "family", "loop"),
    ]);
    expect(groups.map(({ entries }) => entries.map(({ route }) => route.id))).toEqual([["a1", "b1"], ["a2", "b2"]]);
  });

  it("requires both authoritative identities and keeps different families separate", () => {
    const routes = [route("a", "a", "family", "loop"), route("different-family", "b", "another-family", "loop"), route("missing-loop", "c", "family"), route("legacy", "d", undefined, "loop")];
    expect(entranceRouteGroups(routes).map(({ entries }) => entries.map(({ route }) => route.id))).toEqual(routes.map(({ id }) => [id]));
  });
});
