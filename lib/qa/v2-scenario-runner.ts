import { performance } from "node:perf_hooks";
import {
  generateRoutesRequestV2Schema,
  generateRoutesResponseV2Schema,
  type ConstraintViolation,
  type GenerateRoutesRequestV2,
  type GenerateRoutesResponseV2,
  type RouteType,
} from "@/lib/contracts";
import {
  coordinateIsInsideArea,
  lineIsInsideArea,
  type AreaGeometry,
  type GraphRepository,
} from "@/lib/graph";
import {
  createMultiStartRouteSolver,
  DEFAULT_SOLVER_BUDGET,
  type ResolvedAccessFilterContext,
  type SolverBudget,
} from "@/lib/solver";

export type V2ScenarioPack = GenerateRoutesResponseV2["pack"] & { coverage: AreaGeometry };

export type V2ScenarioDefinition = {
  id: string;
  tags: string[];
  typical?: boolean;
  limitSweep?: { from: number; to: number };
  budget?: Partial<SolverBudget>;
  request: GenerateRoutesRequestV2;
  expect: {
    minimumExact?: number;
    maximumExact?: number;
    minimumNearMisses?: number;
    exactShapes?: RouteType[];
    nearMissConstraints?: ConstraintViolation["constraint"][];
    shortageMustBeExplained?: boolean;
    routesMayLeaveFilter?: boolean;
  };
};

export type V2ScenarioSuite = {
  schemaVersion: 2;
  name: string;
  pack: V2ScenarioPack;
  performanceBudgetMs: number;
  scenarios: V2ScenarioDefinition[];
};

export type V2ScenarioReport = {
  schemaVersion: 2;
  suite: string;
  pack: GenerateRoutesResponseV2["pack"];
  passed: boolean;
  summary: { runs: number; passed: number; failed: number; slowestTypicalDurationMs: number };
  scenarios: Array<{
    id: string;
    sourceScenarioId: string;
    durationMs: number;
    exactCount: number;
    nearMissCount: number;
    diagnostics: GenerateRoutesResponseV2["diagnostics"];
    assertions: Array<{ assertion: string; passed: boolean; detail?: string }>;
    passed: boolean;
  }>;
};

type RunnerOptions = {
  suite: V2ScenarioSuite;
  repositoryFactory: () => GraphRepository | Promise<GraphRepository>;
  resolveFilter: (
    request: GenerateRoutesRequestV2,
    repository: GraphRepository,
  ) => ResolvedAccessFilterContext | Promise<ResolvedAccessFilterContext>;
  measureNow?: () => number;
};

function expandedScenarios(suite: V2ScenarioSuite) {
  return suite.scenarios.flatMap((scenario) => {
    if (!scenario.limitSweep) return [{ ...scenario, runId: scenario.id }];
    const { from, to } = scenario.limitSweep;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 20 || from > to) {
      throw new Error(`Scenario ${scenario.id} has an invalid 1–20 limit sweep`);
    }
    return Array.from({ length: to - from + 1 }, (_, index) => ({
      ...scenario,
      runId: `${scenario.id}:limit-${from + index}`,
      request: { ...scenario.request, limit: from + index },
    }));
  });
}

function assertions(
  response: GenerateRoutesResponseV2,
  scenario: V2ScenarioDefinition,
  filter: ResolvedAccessFilterContext,
  durationMs: number,
  performanceBudgetMs: number,
) {
  const result: Array<{ assertion: string; passed: boolean; detail?: string }> = [];
  const record = (assertion: string, passed: boolean, detail?: string) => {
    result.push({ assertion, passed, ...(detail ? { detail } : {}) });
  };
  const routes = [...response.exact, ...response.nearMisses];
  record("response contract", generateRoutesResponseV2Schema.safeParse(response).success);
  record("route IDs are unique", new Set(routes.map(({ id }) => id)).size === routes.length);
  record("all route geometry stays inside exact pack coverage",
    routes.every(({ geometry }) => lineIsInsideArea(geometry.coordinates, filter.coverage)));
  record("all starts match the trailhead filter", routes.every(({ filterMatch }) => filterMatch.start));
  record("graph edge budget is respected",
    response.diagnostics.maximumLoadedDirectedEdges <= DEFAULT_SOLVER_BUDGET.maximumDirectedEdges);
  const expected = scenario.expect;
  if (expected.minimumExact !== undefined) {
    record("minimum exact routes", response.exact.length >= expected.minimumExact,
      `actual=${response.exact.length}; minimum=${expected.minimumExact}`);
  }
  if (expected.maximumExact !== undefined) {
    record("maximum exact routes", response.exact.length <= expected.maximumExact,
      `actual=${response.exact.length}; maximum=${expected.maximumExact}`);
  }
  if (expected.minimumNearMisses !== undefined) {
    record("minimum near misses", response.nearMisses.length >= expected.minimumNearMisses,
      `actual=${response.nearMisses.length}; minimum=${expected.minimumNearMisses}`);
  }
  for (const shape of expected.exactShapes ?? []) {
    record(`exact ${shape} route`, response.exact.some((route) => route.shape === shape));
  }
  for (const constraint of expected.nearMissConstraints ?? []) {
    record(`near miss discloses ${constraint}`, response.nearMisses.some(
      (route) => route.violations.some((violation) => violation.constraint === constraint)));
  }
  if (expected.shortageMustBeExplained && response.exact.length < response.requested) {
    record("requested-count shortage is explained",
      response.diagnostics.exhausted || response.diagnostics.shortfallReasons.length > 0);
  }
  if (expected.routesMayLeaveFilter) {
    record("filter does not clip hiking geometry", routes.some(({ geometry }) => geometry.coordinates.some(
      (coordinate) => !filter.predicates.every((area) => coordinateIsInsideArea(coordinate, area)),
    )));
  }
  if (scenario.typical) {
    record(`typical search completes within ${performanceBudgetMs} ms`, durationMs <= performanceBudgetMs,
      `${durationMs.toFixed(3)} ms`);
  }
  return result;
}

export async function runV2ScenarioSuite(options: RunnerOptions): Promise<V2ScenarioReport> {
  if (options.suite.schemaVersion !== 2 || options.suite.performanceBudgetMs <= 0) {
    throw new Error("Invalid V2 scenario suite metadata");
  }
  const measureNow = options.measureNow ?? (() => performance.now());
  const runs: V2ScenarioReport["scenarios"] = [];
  for (const scenario of expandedScenarios(options.suite)) {
    const request = generateRoutesRequestV2Schema.parse(scenario.request);
    const repository = await options.repositoryFactory();
    try {
      const filter = await options.resolveFilter(request, repository);
      const { coverage: _coverage, ...responsePack } = options.suite.pack;
      const solver = createMultiStartRouteSolver({ pack: responsePack });
      const started = measureNow();
      const response = await solver.generate(request, {
        repository,
        accessFilter: filter,
        budget: { ...DEFAULT_SOLVER_BUDGET, ...scenario.budget },
      });
      const durationMs = Math.max(0, measureNow() - started);
      const evaluated = assertions(response, scenario, filter, durationMs, options.suite.performanceBudgetMs);
      runs.push({
        id: scenario.runId,
        sourceScenarioId: scenario.id,
        durationMs,
        exactCount: response.exact.length,
        nearMissCount: response.nearMisses.length,
        diagnostics: response.diagnostics,
        assertions: evaluated,
        passed: evaluated.every(({ passed }) => passed),
      });
    } finally {
      await repository.close();
    }
  }
  const typicalIds = new Set(options.suite.scenarios.filter(({ typical }) => typical).map(({ id }) => id));
  const passed = runs.filter((run) => run.passed).length;
  return {
    schemaVersion: 2,
    suite: options.suite.name,
    pack: options.suite.pack,
    passed: passed === runs.length,
    summary: {
      runs: runs.length,
      passed,
      failed: runs.length - passed,
      slowestTypicalDurationMs: Math.max(0, ...runs
        .filter(({ sourceScenarioId }) => typicalIds.has(sourceScenarioId))
        .map(({ durationMs }) => durationMs)),
    },
    scenarios: runs,
  };
}
