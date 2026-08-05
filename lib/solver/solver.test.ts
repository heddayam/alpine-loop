import { describe, expect, it } from "vitest";
import tinyFixture from "@/data/fixtures/graph/solver-shapes.json";
import type { GenerateRoutesRequestV1, RouteType } from "@/lib/contracts";
import { FixtureGraphRepository, type FixtureGraphData, type InducedGraph } from "@/lib/graph";
import { DEFAULT_SOLVER_BUDGET } from "./budget";
import { canonicalRouteId, undirectedEdgeKey } from "./canonical";
import { scoreCandidate } from "./candidate";
import { RouteSearchCancelledError, SearchController } from "./control";
import { generateInitialCandidates } from "./generate";

const fixture = tinyFixture as unknown as FixtureGraphData;
const BBOX = [-122.19, 37.15, -122.13, 37.18] as const;

const requestFor = (shape: RouteType): GenerateRoutesRequestV1 => ({
  version: 1,
  packId: "fixture-pack",
  bbox: [...BBOX],
  startAccessPointId: "trailhead-a",
  routeTypes: [shape],
  distanceMiles: { min: 0, max: 20 },
  includeUncertainAccess: false,
  limit: 10,
});

async function tinyGraph(): Promise<InducedGraph> {
  return new FixtureGraphRepository(fixture).getInducedGraph({ bbox: BBOX, includeUncertainAccess: false });
}

describe("initial shape generation", () => {
  for (const shape of ["loop", "lollipop", "out-and-back", "point-to-point"] as const) {
    it(`produces an initial ${shape} candidate`, async () => {
      const graph = await tinyGraph();
      const result = generateInitialCandidates(graph, requestFor(shape));
      const candidate = result.candidates.find((item) => item.shape === shape);
      expect(candidate, `${shape} candidate`).toBeDefined();
      expect(candidate!.traversals[0].from.id).toBe("a");
      if (shape === "point-to-point") {
        expect(candidate!.startAccessPoint.id).not.toBe(candidate!.endAccessPoint.id);
        expect(candidate!.warnings).toContain("Shuttle or two-car logistics required");
      } else {
        expect(candidate!.traversals.at(-1)!.to.id).toBe("a");
      }
    });
  }

  it("obeys shape-specific edge rules", async () => {
    const graph = await tinyGraph();
    const loop = generateInitialCandidates(graph, requestFor("loop")).candidates[0];
    const loopKeys = loop.traversals.map(({ edge }) => undirectedEdgeKey(edge));
    expect(loop.metrics.repeatedEdgeFraction).toBeLessThanOrEqual(0.1);
    if (loop.metrics.repeatedEdgeFraction === 0) expect(new Set(loopKeys).size).toBe(loopKeys.length);

    const outAndBack = generateInitialCandidates(graph, requestFor("out-and-back")).candidates[0];
    expect(outAndBack.traversals[0].from.id).toBe(outAndBack.traversals.at(-1)!.to.id);
    expect(outAndBack.metrics.repeatedEdgeFraction).toBeGreaterThan(0);

    const lollipop = generateInitialCandidates(graph, requestFor("lollipop")).candidates[0];
    expect(lollipop.metrics.repeatedEdgeFraction).toBeGreaterThan(0.1);
    expect(lollipop.metrics.repeatedEdgeFraction).toBeLessThanOrEqual(0.35);
  });

  it("is deterministic across repeated generation", async () => {
    const graph = await tinyGraph();
    const request = { ...requestFor("loop"), routeTypes: ["loop", "out-and-back"] as RouteType[] };
    const first = generateInitialCandidates(graph, request).candidates.map(({ id }) => id);
    const second = generateInitialCandidates(graph, request).candidates.map(({ id }) => id);
    expect(second).toEqual(first);
  });
});

describe("canonical route identity and scoring", () => {
  it("uses the same canonical ID for reversed traversal of the same physical route", async () => {
    const graph = await tinyGraph();
    const forward = graph.edges.find((edge) => edge.fromNodeId === "a" && edge.toNodeId === "b")!;
    const reverse = graph.edges.find((edge) => edge.fromNodeId === "b" && edge.toNodeId === "a")!;
    expect(canonicalRouteId("out-and-back", [forward, reverse])).toBe(
      canonicalRouteId("out-and-back", [reverse, forward]),
    );
  });

  it("reports every violated range without silently relaxing it", async () => {
    const graph = await tinyGraph();
    const candidate = generateInitialCandidates(graph, requestFor("out-and-back")).candidates[0];
    const scored = scoreCandidate(candidate, {
      ...requestFor("out-and-back"),
      distanceMiles: { min: 100, max: 110 },
      elevationGainFeet: { min: 10_000, max: 11_000 },
      maximumElevationFeet: { min: 10_000, max: 11_000 },
      steepestSustainedGradePct: { min: 20, max: 30 },
    });
    expect(scored.exact).toBe(false);
    expect(scored.violations.map(({ constraint }) => constraint)).toEqual([
      "distance",
      "elevation-gain",
      "maximum-elevation",
      "steepest-sustained-grade",
    ]);
    expect(scored.violations.every(({ delta, normalizedDelta }) => delta > 0 && normalizedDelta > 0)).toBe(true);
  });
});

describe("search budgets and cancellation", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_SOLVER_BUDGET).toEqual({
      maximumDirectedEdges: 10_000,
      maximumExpandedStates: 100_000,
      deadlineMs: 3_000,
      maximumRawCandidates: 2_000,
    });
  });

  it("returns deterministic partial diagnostics for edge and state budgets", async () => {
    const graph = await tinyGraph();
    const edgeLimited = generateInitialCandidates(graph, requestFor("loop"), {
      budget: { ...DEFAULT_SOLVER_BUDGET, maximumDirectedEdges: 1 },
    });
    expect(edgeLimited.candidates).toEqual([]);
    expect(edgeLimited.diagnostics.truncationReasons).toEqual(["maximum-directed-edges"]);

    const stateLimited = generateInitialCandidates(graph, requestFor("loop"), {
      budget: { ...DEFAULT_SOLVER_BUDGET, maximumExpandedStates: 0 },
    });
    expect(stateLimited.diagnostics.expandedStates).toBe(0);
    expect(stateLimited.diagnostics.truncationReasons).toEqual(["maximum-expanded-states"]);
  });

  it("checks deadlines and raw candidate limits inside search loops", async () => {
    const graph = await tinyGraph();
    let clock = 0;
    const deadlineLimited = generateInitialCandidates(graph, requestFor("loop"), {
      budget: { ...DEFAULT_SOLVER_BUDGET, deadlineMs: 2 },
      now: () => clock++,
    });
    expect(deadlineLimited.diagnostics.truncationReasons).toContain("deadline");

    const candidateLimited = generateInitialCandidates(graph, requestFor("out-and-back"), {
      budget: { ...DEFAULT_SOLVER_BUDGET, maximumRawCandidates: 1 },
    });
    expect(candidateLimited.candidates).toHaveLength(1);
    expect(candidateLimited.diagnostics.truncationReasons).toContain("maximum-raw-candidates");
  });

  it("throws a distinct cancellation error", async () => {
    const graph = await tinyGraph();
    const abortController = new AbortController();
    abortController.abort(new Error("user cancelled"));
    expect(() =>
      generateInitialCandidates(graph, requestFor("loop"), { signal: abortController.signal }),
    ).toThrow(RouteSearchCancelledError);
  });

  it("exposes direct controller checks for callers composing searches", () => {
    const controller = new SearchController({ ...DEFAULT_SOLVER_BUDGET, maximumExpandedStates: 1 });
    expect(controller.tryExpand()).toBe(true);
    expect(controller.tryExpand()).toBe(false);
    expect(controller.diagnostics().exhausted).toBe(true);
  });
});
