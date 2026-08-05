import { describe, expect, it } from "vitest";
import type { EdgeTraversal, GraphEdge, GraphNode } from "@/lib/graph";
import { analyzeRouteTopology } from "./topology";

function node(id: string): GraphNode {
  const index = id.charCodeAt(0) - 65;
  return { id, lon: index / 100, lat: index / 200, elevationMeters: 100, flags: [] };
}

function walk(sequence: readonly string[], lengths: Readonly<Record<string, number>> = {}): EdgeTraversal[] {
  return sequence.slice(0, -1).map((fromId, index) => {
    const toId = sequence[index + 1]!;
    const endpoints = [fromId, toId].sort();
    const physicalId = endpoints.join("-");
    const from = node(fromId);
    const to = node(toId);
    const edge: GraphEdge = {
      id: `${physicalId}:${index}`,
      fromNodeId: fromId,
      toNodeId: toId,
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
      lengthMeters: lengths[physicalId] ?? 100,
      gainMeters: 0,
      lossMeters: 0,
      maximumElevationMeters: 100,
      maximumSustainedGradePct: 0,
      accessState: "public",
      trailName: physicalId,
      sourceIds: ["fixture"],
      flags: [],
    };
    return { edge, from, to };
  });
}

describe("closed-walk topology analysis", () => {
  it("classifies a simple cycle as one loop", () => {
    const topology = analyzeRouteTopology(walk(["A", "B", "C", "A"]));
    expect(topology).toMatchObject({ closed: true, cycleCount: 1, cycleStructure: "single-loop", classification: "loop" });
    expect(topology.repeatedPhysicalTrailFraction).toBe(0);
  });

  it("recognizes a figure-eight as a multi-cycle loop", () => {
    const topology = analyzeRouteTopology(walk(["A", "B", "C", "A", "D", "E", "A"]));
    expect(topology).toMatchObject({ cycleCount: 2, cycleStructure: "figure-eight", classification: "loop" });
  });

  it("recognizes chained cycles that share articulation vertices", () => {
    const topology = analyzeRouteTopology(walk(["C", "A", "B", "C", "D", "E", "F", "G", "E", "C"]));
    expect(topology).toMatchObject({ cycleCount: 3, cycleStructure: "chained-loops", classification: "loop" });
  });

  it("treats a retraced bridge between cycles as a lollipop connector", () => {
    const topology = analyzeRouteTopology(walk(
      ["C", "A", "B", "C", "D", "E", "F", "D", "C"],
      { "C-D": 200 },
    ));
    expect(topology.cycleCount).toBe(2);
    expect(topology.cycleStructure).toBe("chained-loops");
    expect(topology.repeatedPhysicalTrailFraction).toBeCloseTo(0.2);
    expect(topology.repeatsFormStemsOrConnectors).toBe(true);
    expect(topology.classification).toBe("lollipop");
  });

  it("classifies a conventional stem and cycle as a lollipop", () => {
    const topology = analyzeRouteTopology(walk(["S", "A", "B", "C", "A", "S"]));
    expect(topology).toMatchObject({ cycleCount: 1, cycleStructure: "single-loop", repeatsFormStemsOrConnectors: true, classification: "lollipop" });
    expect(topology.repeatedPhysicalTrailFraction).toBeCloseTo(0.2);
  });

  it("classifies a fully retraced linear walk as out-and-back", () => {
    const topology = analyzeRouteTopology(walk(["S", "A", "B", "C", "B", "A", "S"]));
    expect(topology).toMatchObject({ cycleCount: 0, cycleStructure: "none", mostlyRetraced: true, classification: "out-and-back" });
    expect(topology.repeatedPhysicalTrailFraction).toBeCloseTo(0.5);
  });

  it("rejects arbitrary repetition on a physical cycle edge", () => {
    const topology = analyzeRouteTopology(walk(["A", "B", "C", "D", "E", "F", "A", "B", "A"]));
    expect(topology.cycleCount).toBe(1);
    expect(topology.repeatedPhysicalTrailFraction).toBeCloseTo(0.25);
    expect(topology.repeatsFormStemsOrConnectors).toBe(false);
    expect(topology.classification).toBe("unclassified");
  });

  it("uses the inclusive loop and lollipop repetition thresholds deterministically", () => {
    const loopAtTenPercent = analyzeRouteTopology(walk(
      ["S", "A", "B", "C", "D", "E", "F", "G", "H", "A", "S"],
      { "A-S": 100 },
    ));
    expect(loopAtTenPercent.repeatedPhysicalTrailFraction).toBeCloseTo(0.1);
    expect(loopAtTenPercent.classification).toBe("loop");

    const lollipopAtThirtyFivePercent = analyzeRouteTopology(walk(
      ["S", "A", "B", "C", "A", "S"],
      { "A-S": 350 },
    ));
    expect(lollipopAtThirtyFivePercent.repeatedPhysicalTrailFraction).toBeCloseTo(0.35);
    expect(lollipopAtThirtyFivePercent.classification).toBe("lollipop");
  });

  it("marks a disconnected or open traversal sequence unclassified", () => {
    const broken = walk(["A", "B", "C"]);
    broken[1] = { ...broken[1]!, from: node("D") };
    expect(analyzeRouteTopology(broken)).toMatchObject({ closed: false, contiguous: false, classification: "unclassified" });
  });
});
