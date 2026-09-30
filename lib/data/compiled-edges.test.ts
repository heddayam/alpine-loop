import { describe, expect, it } from "vitest";
import { compiledEdgesForSegment, footSegmentAccessState, footWayDirectionAccessState } from "./compiled-edges";
import { normalizeOsmOpl } from "./osm/opl";
import type { EdgeMetrics } from "./metrics";

const metrics: EdgeMetrics = {
  lengthM: 100, gainM: 10, lossM: 3, maxElevationM: 100, maxSustainedGradePct: 10,
  elevationProfile: [{ distanceMeters: 0, elevationMeters: 90 }, { distanceMeters: 100, elevationMeters: 100 }],
};
function compile(tags: string, nodeTags = "") {
  const source = normalizeOsmOpl(`n1 T${nodeTags} x0 y0\nn2 T x0.001 y0\nw1 T${tags} Nn1,n2`, "fixture");
  const way = source.ways[0]!;
  return { source, edges: compiledEdgesForSegment(way, 0, way.coordinates!, metrics, {
    nodeFlags: way.nodeIds.map(id => source.nodes.find(node => node.id === id)!.flags),
  }) };
}

describe("compiled foot movement", () => {
  it("folds actual gate restrictions into both departure and arrival segments", () => {
    const { source, edges } = compile("highway=path,foot=yes", "barrier=gate,foot=no");
    expect(source.nodes[0]!.flags).toEqual(expect.arrayContaining(["barrier:gate", "foot-access:prohibited"]));
    expect(edges.map(edge => [edge.fromNode, edge.toNode, edge.accessState])).toEqual([
      ["osm-node-1", "osm-node-2", "prohibited"], ["osm-node-2", "osm-node-1", "prohibited"],
    ]);
    expect(footSegmentAccessState("private", [["foot-access:public"]])).toBe("private");
    expect(footSegmentAccessState("prohibited", [["foot-access:unknown"]])).toBe("prohibited");
    expect(footSegmentAccessState("public", [["foot-access:closed"], ["foot-access:prohibited"]])).toBe("closed");
  });

  it("does not make bare gates, private information boards, or motor restrictions foot barriers", () => {
    for (const tags of ["barrier=gate", "information=board,access=private", "barrier=bollard,motorcar=no", "amenity=parking,access=private"]) {
      expect(compile("highway=path,foot=yes", tags).edges.map(edge => edge.accessState)).toEqual(["public", "public"]);
    }
    expect(compile("highway=track,foot=yes,motorcar=private,oneway=yes").edges).toHaveLength(2);
    expect(compile("highway=track,foot=yes,motorcar=private").edges[0]!.accessState).toBe("public");
    expect(compile("highway=path,foot=yes", "barrier=gate,foot=yes,foot:conditional=no%20%@%20%(winter)").edges[0]!.accessState).toBe("unknown");
  });

  it("preserves foot-specific orientation and forbids both-denied source directions", () => {
    const reverse = compile("highway=track,foot=yes,oneway=yes,foot:forward=no").edges;
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ fromNode: "osm-node-2", toNode: "osm-node-1", accessState: "public" });
    const denied = compile("highway=path,foot=yes,foot:forward=no,foot:backward=no");
    expect(denied.source.ways[0]!.flags).toContain("foot-direction:none");
    expect(denied.edges.every(edge => edge.accessState === "prohibited")).toBe(true);
  });

  it("preserves differing directional permission without losing the usable opposite movement", () => {
    const restrictedForward = compile("highway=track,foot=yes,foot:forward=private,foot:backward=yes");
    expect(restrictedForward.source.ways[0]!.accessState).toBe("public");
    expect(restrictedForward.edges.map(edge => edge.accessState)).toEqual(["private", "public"]);
    const forwardOnly = compile("highway=track,foot=no,foot:forward=yes");
    expect(forwardOnly.edges.map(edge => edge.accessState)).toEqual(["public", "prohibited"]);
    const reversed = compile("highway=track,foot=yes,oneway:foot=-1,foot:backward=private");
    expect(reversed.edges[0]).toMatchObject({ fromNode: "osm-node-2", toNode: "osm-node-1", accessState: "private" });
    expect(reversed.source.ways[0]!.flags).toEqual(expect.arrayContaining([
      "foot-forward-access:private", "foot-backward-access:prohibited",
    ]));
    const conditional = compile("highway=track,foot=yes,foot:forward:conditional=no%20%@%20%(winter)");
    expect(conditional.edges.map(edge => edge.accessState)).toEqual(["unknown", "public"]);
    expect(footWayDirectionAccessState("public", conditional.source.ways[0]!.flags, "forward")).toBe("unknown");
  });

  it("keeps resolved way permission bounded by the actual passage and reverses physical metrics", () => {
    const { source } = compile("highway=path,foot=yes", "barrier=gate,access=private");
    const way = source.ways[0]!;
    const edges = compiledEdgesForSegment(way, 0, way.coordinates!, metrics, {
      accessState: "public", sourceRefs: ["resolved"], nodeFlags: [source.nodes[0]!.flags, []],
    });
    expect(edges.map(edge => edge.accessState)).toEqual(["private", "private"]);
    expect(edges[1]).toMatchObject({ stablePhysicalId: edges[0]!.stablePhysicalId, gainM: 3, lossM: 10, sourceRefs: ["resolved"] });
    expect(edges[1]!.elevationProfile).toEqual([{ distanceMeters: 0, elevationMeters: 100 }, { distanceMeters: 100, elevationMeters: 90 }]);
    expect(() => footSegmentAccessState("public", [["foot-access:invalid"]])).toThrow("Unsupported foot passage state");
  });
});
