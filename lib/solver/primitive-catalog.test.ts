import { describe, expect, test } from "vitest";

import type { DecisionNetwork, TopologyDecisionEdge } from "@/lib/graph";

import { DeterministicClosedRoutePrimitiveCatalog } from "./primitive-catalog";

function edge(id: number, from: number, to: number, physicalEdgeKey: number): TopologyDecisionEdge {
  return {
    id,
    fromDecisionNodeId: from,
    toDecisionNodeId: to,
    lengthMeters: 100,
    gainMeters: id,
    lossMeters: 0,
    maximumElevationMeters: 100,
    maximumSustainedGradePct: 5,
    accessState: "public",
    trailNames: ["Fixture Trail"],
    sourceIds: ["fixture"],
    flags: [],
    isBridge: false,
    twoEdgeComponentId: 1,
    vertexBlockId: 1,
    members: [{ sequenceIndex: 0, edgeKey: id, physicalEdgeKey }],
  };
}

function network(): DecisionNetwork {
  const edges = [
    edge(1, 1, 2, 1), edge(2, 2, 3, 2), edge(3, 3, 1, 3),
    edge(4, 2, 1, 1), edge(5, 3, 2, 2), edge(6, 1, 3, 3),
  ];
  return {
    profile: "known",
    networkId: 7,
    nodes: new Map([
      [1, { id: 1, sourceNodeId: "s", connectedComponentId: 1, twoEdgeComponentId: 1, isArticulation: false, vertexBlockIds: [1] }],
      [2, { id: 2, sourceNodeId: "a", connectedComponentId: 1, twoEdgeComponentId: 1, isArticulation: false, vertexBlockIds: [1] }],
      [3, { id: 3, sourceNodeId: "b", connectedComponentId: 1, twoEdgeComponentId: 1, isArticulation: false, vertexBlockIds: [1] }],
    ]),
    edges,
    blocks: [{
      id: 1,
      kind: "vertex-cycle",
      decisionNodeIds: [1, 2, 3],
      decisionEdgeIds: edges.map(({ id }) => id),
      cycleRank: 1,
      totalPhysicalLengthMeters: 300,
      minimumCycleLengthMeters: 300,
      minimumElevationMeters: 0,
      maximumElevationMeters: 100,
      trailNames: ["Fixture Trail"],
    }],
    blockLinks: [],
    estimatedByteSize: 1_000,
    contentHash: "fixture-hash",
  };
}

describe("DeterministicClosedRoutePrimitiveCatalog", () => {
  test("generates stable bounded physical-cycle primitives and reports cache hits", async () => {
    const fixture = network();
    const catalog = new DeterministicClosedRoutePrimitiveCatalog({
      dataVersion: "fixture-v1",
      maximumResidentBytes: 10_000,
      policy: {
        version: "test-v1",
        maximumPrimitivesPerBlock: 1,
        distanceBucketMeters: 100,
        elevationBucketMeters: 10,
        maximumStableSpanningTreeOrders: 4,
      },
    });
    const first = await catalog.getPrimitives(fixture, fixture.blocks[0]!);
    const second = await catalog.getPrimitives(fixture, fixture.blocks[0]!);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      networkId: 7,
      blockId: 1,
      distanceMeters: 300,
      physicalEdgeSignature: [1, 2, 3],
      cycleCount: 1,
    });
    expect(catalog.getDiagnostics()).toMatchObject({ hits: 1, misses: 1, generationCount: 1 });
  });

  test("uses byte-bounded eviction and honors cancellation", async () => {
    const fixture = network();
    const catalog = new DeterministicClosedRoutePrimitiveCatalog({
      dataVersion: "fixture-v1",
      maximumResidentBytes: 1,
    });
    await catalog.getPrimitives(fixture, fixture.blocks[0]!);
    expect(catalog.getDiagnostics().residentBytes).toBe(0);
    const abort = new AbortController();
    abort.abort("stop");
    await expect(catalog.getPrimitives(fixture, fixture.blocks[0]!, abort.signal)).rejects.toThrow(
      "Route generation was cancelled",
    );
  });
});
