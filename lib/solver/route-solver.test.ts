import { describe, expect, it } from "vitest";
import tinyFixture from "@/data/fixtures/graph/tiny.json";
import { generateRoutesResponseV1Schema, type GenerateRoutesRequestV1 } from "@/lib/contracts";
import { FixtureGraphRepository, type FixtureGraphData } from "@/lib/graph";
import { DEFAULT_SOLVER_BUDGET, type SolverBudget } from "./budget";
import { scoreCandidate } from "./candidate";
import { RouteSearchCancelledError } from "./control";
import { selectDiverseCandidates, undirectedDistanceOverlap } from "./diversity";
import { generateInitialCandidates } from "./generate";
import { createRouteSolver } from "./route-solver";

const BBOX = [-122.19, 37.15, -122.13, 37.18] as const;
const PACK = {
  id: "fixture-pack",
  schemaVersion: "1",
  dataVersion: "fixture-v1",
  builtAt: "2026-08-04T00:00:00Z",
} as const;

function request(overrides: Partial<GenerateRoutesRequestV1> = {}): GenerateRoutesRequestV1 {
  return {
    version: 1,
    packId: PACK.id,
    bbox: [...BBOX],
    startAccessPointId: "trailhead-a",
    routeTypes: ["loop", "lollipop", "out-and-back", "point-to-point"],
    distanceMiles: { min: 0, max: 20 },
    includeUncertainAccess: false,
    limit: 10,
    ...overrides,
  };
}

function context(repository: FixtureGraphRepository, budget: SolverBudget = DEFAULT_SOLVER_BUDGET) {
  return { repository, budget, now: () => 1_000 };
}

function fixtureRepository(): FixtureGraphRepository {
  return new FixtureGraphRepository(tinyFixture as unknown as FixtureGraphData);
}

const solver = createRouteSolver({ pack: PACK, sourceConfidence: "medium" });

describe("complete RouteSolver response", () => {
  it("is schema-valid and deterministic across repeats", async () => {
    const requested = request({ limit: 20 });
    const first = await solver.generate(requested, context(fixtureRepository()));
    const second = await solver.generate(requested, context(fixtureRepository()));

    expect(generateRoutesResponseV1Schema.parse(first)).toEqual(first);
    expect(second).toEqual(first);
    expect(first.requestId).toMatch(/^route-request-/);
    expect(first.pack).toEqual(PACK);
  });

  for (const shape of ["loop", "lollipop", "out-and-back", "point-to-point"] as const) {
    it(`returns a complete exact ${shape} route`, async () => {
      const response = await solver.generate(
        request({ routeTypes: [shape], limit: 1 }),
        context(fixtureRepository()),
      );
      expect(response.exact).toHaveLength(1);
      const route = response.exact[0];
      expect(route.shape).toBe(shape);
      expect(route.geometry.coordinates.length).toBeGreaterThan(1);
      expect(route.source).toEqual({
        freshness: PACK.builtAt,
        confidence: "medium",
        sourceIds: ["fixture-source"],
      });
      expect(route.elevationSamples?.at(0)?.distanceMeters).toBe(0);
      expect(route.elevationSamples?.at(-1)?.distanceMeters).toBeCloseTo(route.distanceMeters);
      expect(route.warnings).toContain("Planning aid only; verify current trail and access conditions");
    });
  }

  it("honors limits 1 and 20 without duplicates or padding and explains a shortage", async () => {
    const one = await solver.generate(request({ limit: 1 }), context(fixtureRepository()));
    expect(one.exact).toHaveLength(1);

    const twenty = await solver.generate(request({ limit: 20 }), context(fixtureRepository()));
    const ids = [...twenty.exact, ...twenty.nearMisses].map(({ id }) => id);
    expect(twenty.requested).toBe(20);
    expect(twenty.exact.length).toBeLessThan(20);
    expect(new Set(ids).size).toBe(ids.length);
    expect(twenty.diagnostics.exhausted).toBe(true);
    expect(twenty.diagnostics.truncationReasons).toContain("fewer-exact-routes-than-requested");
  });
});

function asymmetricFixture(): FixtureGraphData {
  return {
    packId: PACK.id,
    nodes: [
      { id: "s", lon: 0, lat: 0, elevationMeters: 100, flags: [] },
      { id: "t", lon: 0.001, lat: 0, elevationMeters: 120, flags: [] },
    ],
    directedEdges: [
      {
        id: "climb",
        fromNodeId: "s",
        toNodeId: "t",
        lengthMeters: 100,
        gainMeters: 30,
        lossMeters: 5,
        maximumElevationMeters: 120,
        maximumSustainedGradePct: 9,
        sourceIds: ["metrics-source"],
      },
      {
        id: "descent",
        fromNodeId: "t",
        toNodeId: "s",
        lengthMeters: 100,
        gainMeters: 7,
        lossMeters: 25,
        maximumElevationMeters: 120,
        maximumSustainedGradePct: 4,
        sourceIds: ["metrics-source"],
      },
    ],
    accessPoints: [
      {
        id: "start",
        nodeId: "s",
        name: "Start",
        kind: "trailhead",
        accessState: "public",
        confidence: "high",
        parkingEvidence: "fixture",
        sourceIds: ["access-source"],
      },
    ],
  };
}

const METERS_PER_FOOT = 0.3048;

describe("direction-aware metrics and constraints", () => {
  const metricBbox = [-0.01, -0.01, 0.01, 0.01] as const;
  const metricRequest = (overrides: Partial<GenerateRoutesRequestV1> = {}): GenerateRoutesRequestV1 =>
    request({
      bbox: [...metricBbox],
      startAccessPointId: "start",
      routeTypes: ["out-and-back"],
      distanceMiles: { min: 0.12, max: 0.13 },
      elevationGainFeet: { min: 120, max: 122 },
      maximumElevationFeet: { min: 390, max: 400 },
      steepestSustainedGradePct: { min: 8, max: 10 },
      limit: 1,
      ...overrides,
    });

  it("sums forward and reverse gain/loss and satisfies every optional range", async () => {
    const repository = new FixtureGraphRepository(asymmetricFixture());
    const response = await solver.generate(metricRequest(), context(repository));
    expect(response.exact).toHaveLength(1);
    expect(response.exact[0]).toMatchObject({
      distanceMeters: 200,
      elevationGainMeters: 37,
      elevationLossMeters: 30,
      maximumElevationMeters: 120,
      steepestSustainedGradePct: 9,
    });
  });

  it("separates a near miss and discloses every violated min/max constraint", async () => {
    const repository = new FixtureGraphRepository(asymmetricFixture());
    const response = await solver.generate(
      metricRequest({
        distanceMiles: { min: 1, max: 2 },
        elevationGainFeet: { min: 1_000, max: 2_000 },
        maximumElevationFeet: { min: 1_000, max: 2_000 },
        steepestSustainedGradePct: { min: 20, max: 30 },
      }),
      context(repository),
    );
    expect(response.exact).toEqual([]);
    expect(response.nearMisses).toHaveLength(1);
    expect(response.nearMisses[0].violations.map(({ constraint }) => constraint)).toEqual([
      "distance",
      "elevation-gain",
      "maximum-elevation",
      "steepest-sustained-grade",
    ]);
    expect(response.nearMisses[0].violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ constraint: "elevation-gain", value: 37, min: 1_000 * METERS_PER_FOOT }),
        expect.objectContaining({ constraint: "maximum-elevation", value: 120, min: 1_000 * METERS_PER_FOOT }),
      ]),
    );
    expect(response.nearMisses[0].violations.every(({ delta, normalizedDelta }) => delta > 0 && normalizedDelta > 0)).toBe(true);
  });

  it("enforces the maximum side of every range", async () => {
    const graph = await new FixtureGraphRepository(asymmetricFixture()).getInducedGraph({
      bbox: metricBbox,
      includeUncertainAccess: false,
    });
    const candidate = generateInitialCandidates(
      graph,
      metricRequest({
        distanceMiles: { min: 0, max: 1 },
        elevationGainFeet: undefined,
        maximumElevationFeet: undefined,
        steepestSustainedGradePct: undefined,
      }),
    ).candidates[0];
    const scored = scoreCandidate(
      candidate,
      metricRequest({
        distanceMiles: { min: 0, max: 0.01 },
        elevationGainFeet: { min: 0, max: 1 },
        maximumElevationFeet: { min: 0, max: 1 },
        steepestSustainedGradePct: { min: 0, max: 1 },
      }),
    );
    expect(scored.violations.map(({ constraint }) => constraint)).toEqual([
      "distance",
      "elevation-gain",
      "maximum-elevation",
      "steepest-sustained-grade",
    ]);
    expect(scored.violations.every(({ value, max }) => value > max)).toBe(true);
  });
});

function lollipopFixture(cycleEdgeLength: number): FixtureGraphData {
  const pairs = [
    ["stem", "s", "j", 20],
    ["cycle-a", "j", "a", cycleEdgeLength],
    ["cycle-b", "a", "b", cycleEdgeLength],
    ["cycle-c", "b", "j", cycleEdgeLength],
  ] as const;
  return {
    packId: PACK.id,
    nodes: [
      { id: "s", lon: 0, lat: 0, elevationMeters: 10, flags: [] },
      { id: "j", lon: 0.001, lat: 0, elevationMeters: 11, flags: [] },
      { id: "a", lon: 0.002, lat: 0, elevationMeters: 12, flags: [] },
      { id: "b", lon: 0.001, lat: 0.001, elevationMeters: 13, flags: [] },
    ],
    directedEdges: pairs.flatMap(([id, fromNodeId, toNodeId, lengthMeters]) => [
      { id: `${id}:forward`, fromNodeId, toNodeId, lengthMeters, maximumSustainedGradePct: 1 },
      { id: `${id}:reverse`, fromNodeId: toNodeId, toNodeId: fromNodeId, lengthMeters, maximumSustainedGradePct: 1 },
    ]),
    accessPoints: [
      {
        id: "start",
        nodeId: "s",
        name: "Start",
        kind: "trailhead",
        accessState: "public",
        confidence: "high",
        parkingEvidence: "fixture",
        sourceIds: ["fixture-source"],
      },
    ],
  };
}

describe("shape quality and diversity", () => {
  it("accepts only lollipops whose complete repeated stem is at most 35%", async () => {
    const bbox = [-0.01, -0.01, 0.01, 0.01] as const;
    const lollipopRequest = request({
      bbox: [...bbox],
      startAccessPointId: "start",
      routeTypes: ["lollipop"],
      distanceMiles: { min: 0, max: 1 },
      limit: 1,
    });
    const rejected = await new FixtureGraphRepository(lollipopFixture(20)).getInducedGraph({
      bbox,
      includeUncertainAccess: false,
    });
    const accepted = await new FixtureGraphRepository(lollipopFixture(30)).getInducedGraph({
      bbox,
      includeUncertainAccess: false,
    });
    expect(generateInitialCandidates(rejected, lollipopRequest).candidates).toEqual([]);
    const candidate = generateInitialCandidates(accepted, lollipopRequest).candidates[0];
    expect(candidate).toBeDefined();
    const completeRepeatedStemShare = (candidate.metrics.repeatedEdgeFraction * 2);
    expect(completeRepeatedStemShare).toBeLessThanOrEqual(0.35);
  });

  it("rejects a ranked candidate when over 80% of its undirected distance overlaps", async () => {
    const graph = await fixtureRepository().getInducedGraph({ bbox: BBOX, includeUncertainAccess: false });
    const candidates = generateInitialCandidates(
      graph,
      request({ routeTypes: ["out-and-back"] }),
    ).candidates.map((candidate) => scoreCandidate(candidate, request({ routeTypes: ["out-and-back"] })));
    const short = candidates.find((candidate) => candidate.traversals.length === 2)!;
    const longer = candidates.find(
      (candidate) => candidate.traversals.length > 2 && undirectedDistanceOverlap(short, candidate) > 0.8,
    )!;
    expect(undirectedDistanceOverlap(short, longer)).toBeGreaterThan(0.8);
    expect(selectDiverseCandidates([short], 1, [longer])).toEqual([]);
  });

  it("returns no more than three distinctly ranked near misses", async () => {
    const response = await solver.generate(
      request({ distanceMiles: { min: 100, max: 110 }, limit: 20 }),
      context(fixtureRepository()),
    );
    expect(response.exact).toEqual([]);
    expect(response.nearMisses.length).toBeGreaterThan(0);
    expect(response.nearMisses.length).toBeLessThanOrEqual(3);
    expect(new Set(response.nearMisses.map(({ id }) => id)).size).toBe(response.nearMisses.length);
    expect(response.nearMisses.every(({ violations }) => violations.length > 0)).toBe(true);
  });
});

describe("full-response budgets and cancellation", () => {
  const cases: Array<[string, SolverBudget, string, (() => number)?]> = [
    ["directed edge cap", { ...DEFAULT_SOLVER_BUDGET, maximumDirectedEdges: 1 }, "maximum-directed-edges"],
    ["expanded state cap", { ...DEFAULT_SOLVER_BUDGET, maximumExpandedStates: 0 }, "maximum-expanded-states"],
    ["raw candidate cap", { ...DEFAULT_SOLVER_BUDGET, maximumRawCandidates: 1 }, "maximum-raw-candidates"],
  ];

  for (const [label, budget, reason] of cases) {
    it(`reports ${label} with deterministic partial diagnostics`, async () => {
      const response = await solver.generate(request({ limit: 20 }), context(fixtureRepository(), budget));
      expect(response.diagnostics.exhausted).toBe(true);
      expect(response.diagnostics.truncationReasons).toContain(reason);
      if (response.exact.length > 0) {
        expect(response.exact.every(({ warnings }) => warnings.some((warning) => warning.includes("truncated")))).toBe(true);
      }
    });
  }

  it("reports the deadline budget", async () => {
    let clock = 0;
    const response = await solver.generate(request({ limit: 20 }), {
      repository: fixtureRepository(),
      budget: { ...DEFAULT_SOLVER_BUDGET, deadlineMs: 2 },
      now: () => clock++,
    });
    expect(response.diagnostics.truncationReasons).toContain("deadline");
  });

  it("throws the distinct cancellation error before repository work", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    await expect(
      solver.generate(request(), {
        repository: fixtureRepository(),
        budget: DEFAULT_SOLVER_BUDGET,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RouteSearchCancelledError);
  });
});
