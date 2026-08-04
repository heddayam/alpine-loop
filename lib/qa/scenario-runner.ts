import { performance } from "node:perf_hooks";
import {
  generateRoutesRequestV1Schema,
  generateRoutesResponseV1Schema,
  type ConstraintViolation,
  type GenerateRoutesRequestV1,
  type GenerateRoutesResponseV1,
  type RouteType,
} from "@/lib/contracts";
import type { GraphRepository } from "@/lib/graph";
import {
  createRouteSolver,
  DEFAULT_SOLVER_BUDGET,
  type SolverBudget,
} from "@/lib/solver";

export type ScenarioPackMetadata = GenerateRoutesResponseV1["pack"];

export type ScenarioExpectation = {
  minimumExact?: number;
  maximumExact?: number;
  minimumNearMisses?: number;
  maximumNearMisses?: number;
  exactShapes?: RouteType[];
  nearMissConstraints?: ConstraintViolation["constraint"][];
  exhausted?: boolean;
  truncationReasons?: string[];
  forbidUncertainRoutes?: boolean;
  requireUncertainRoute?: boolean;
  shortageMustBeExplained?: boolean;
  sourceFreshness?: string;
};

export type ScenarioDefinition = {
  id: string;
  tags: string[];
  typical?: boolean;
  sourceFreshness?: string;
  startAccessPoint?: { accessState: "public" | "unknown" };
  limitSweep?: { from: number; to: number };
  budget?: Partial<SolverBudget>;
  request: GenerateRoutesRequestV1;
  expect: ScenarioExpectation;
};

export type ScenarioSuite = {
  schemaVersion: 1;
  name: string;
  pack: ScenarioPackMetadata;
  performanceBudgetMs: number;
  scenarios: ScenarioDefinition[];
};

export type ScenarioRun = {
  id: string;
  sourceScenarioId: string;
  tags: string[];
  requested: number;
  durationMs: number;
  exactCount: number;
  nearMissCount: number;
  routeShapes: RouteType[];
  diagnostics: GenerateRoutesResponseV1["diagnostics"];
  assertions: Array<{ assertion: string; passed: boolean; detail?: string }>;
  passed: boolean;
};

export type ScenarioReport = {
  schemaVersion: 1;
  suite: string;
  pack: ScenarioPackMetadata;
  performanceBudgetMs: number;
  passed: boolean;
  summary: {
    scenarioRuns: number;
    passed: number;
    failed: number;
    typicalRuns: number;
    slowestTypicalDurationMs: number;
  };
  scenarios: ScenarioRun[];
};

export type ScenarioRunnerOptions = {
  suite: ScenarioSuite;
  repositoryFactory: () => GraphRepository | Promise<GraphRepository>;
  measureNow?: () => number;
};

function assertSuite(suite: ScenarioSuite): void {
  if (suite.schemaVersion !== 1 || !suite.name || !Number.isFinite(suite.performanceBudgetMs) || suite.performanceBudgetMs <= 0) {
    throw new Error("Invalid scenario suite metadata");
  }
  const ids = new Set<string>();
  for (const scenario of suite.scenarios) {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`Scenario IDs must be non-empty and unique: ${scenario.id}`);
    ids.add(scenario.id);
    generateRoutesRequestV1Schema.parse(scenario.request);
    if (scenario.request.packId !== suite.pack.id) {
      throw new Error(`Scenario ${scenario.id} targets ${scenario.request.packId}, expected ${suite.pack.id}`);
    }
    if (scenario.limitSweep) {
      const { from, to } = scenario.limitSweep;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 20 || from > to) {
        throw new Error(`Scenario ${scenario.id} has an invalid 1-20 limit sweep`);
      }
    }
    if (scenario.startAccessPoint && scenario.request.startAccessPointId) {
      throw new Error(`Scenario ${scenario.id} cannot combine a start selector with a fixed access-point ID`);
    }
  }
}

function expandedScenarios(suite: ScenarioSuite): Array<ScenarioDefinition & { runId: string }> {
  return suite.scenarios.flatMap((scenario) => {
    if (!scenario.limitSweep) return [{ ...scenario, runId: scenario.id }];
    const runs: Array<ScenarioDefinition & { runId: string }> = [];
    for (let limit = scenario.limitSweep.from; limit <= scenario.limitSweep.to; limit += 1) {
      runs.push({
        ...scenario,
        runId: `${scenario.id}:limit-${limit}`,
        request: { ...scenario.request, limit },
      });
    }
    return runs;
  });
}

function positionInside(
  [lon, lat]: readonly [number, number],
  [west, south, east, north]: GenerateRoutesRequestV1["bbox"],
): boolean {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function isUncertain(route: GenerateRoutesResponseV1["exact"][number]): boolean {
  return route.startAccessPoint.accessState === "unknown" ||
    route.endAccessPoint.accessState === "unknown" ||
    route.warnings.some((warning) => warning.toLowerCase().includes("uncertain"));
}

function evaluate(
  response: GenerateRoutesResponseV1,
  scenario: ScenarioDefinition,
  durationMs: number,
  performanceBudgetMs: number,
): ScenarioRun["assertions"] {
  const assertions: ScenarioRun["assertions"] = [];
  const record = (assertion: string, passed: boolean, detail?: string) => {
    assertions.push({ assertion, passed, ...(detail ? { detail } : {}) });
  };
  const routes = [...response.exact, ...response.nearMisses];
  const ids = routes.map(({ id }) => id);

  record("response contract", generateRoutesResponseV1Schema.safeParse(response).success);
  record("requested count echoed", response.requested === scenario.request.limit, `actual=${response.requested}; expected=${scenario.request.limit}`);
  record("exact count does not exceed request", response.exact.length <= scenario.request.limit);
  record("near misses capped at three", response.nearMisses.length <= 3);
  record("route IDs are unique across exact and near-miss sections", new Set(ids).size === ids.length);
  record(
    "every coordinate stays inside the hard rectangle",
    routes.every((route) => route.geometry.coordinates.every((coordinate) => positionInside(coordinate, scenario.request.bbox))),
  );

  const expectation = scenario.expect;
  if (expectation.minimumExact !== undefined) {
    record("minimum exact routes", response.exact.length >= expectation.minimumExact, `actual=${response.exact.length}; minimum=${expectation.minimumExact}`);
  }
  if (expectation.maximumExact !== undefined) {
    record("maximum exact routes", response.exact.length <= expectation.maximumExact, `actual=${response.exact.length}; maximum=${expectation.maximumExact}`);
  }
  if (expectation.minimumNearMisses !== undefined) {
    record("minimum near misses", response.nearMisses.length >= expectation.minimumNearMisses, `actual=${response.nearMisses.length}; minimum=${expectation.minimumNearMisses}`);
  }
  if (expectation.maximumNearMisses !== undefined) {
    record("maximum near misses", response.nearMisses.length <= expectation.maximumNearMisses, `actual=${response.nearMisses.length}; maximum=${expectation.maximumNearMisses}`);
  }
  for (const shape of expectation.exactShapes ?? []) {
    record(`exact ${shape} route`, response.exact.some((route) => route.shape === shape));
  }
  for (const constraint of expectation.nearMissConstraints ?? []) {
    record(
      `near miss discloses ${constraint}`,
      response.nearMisses.some((route) => route.violations.some((violation) => violation.constraint === constraint)),
    );
  }
  if (expectation.exhausted !== undefined) {
    record("budget exhaustion state", response.diagnostics.exhausted === expectation.exhausted);
  }
  for (const reason of expectation.truncationReasons ?? []) {
    record(`truncation reason ${reason}`, response.diagnostics.truncationReasons.includes(reason));
  }
  if (expectation.forbidUncertainRoutes) {
    record("known-only policy excludes uncertain routes", routes.every((route) => !isUncertain(route)));
  }
  if (expectation.requireUncertainRoute) {
    record("uncertain route appears only after opt-in", routes.some(isUncertain));
  }
  if (expectation.shortageMustBeExplained && response.exact.length < response.requested) {
    record(
      "requested-count shortage is explained",
      response.diagnostics.exhausted || response.diagnostics.truncationReasons.length > 0,
    );
  }
  if (expectation.sourceFreshness) {
    record(
      "source freshness is propagated",
      routes.length > 0 && routes.every((route) => route.source.freshness === expectation.sourceFreshness),
    );
  }
  if (scenario.typical) {
    record(
      `typical search completes within ${performanceBudgetMs} ms`,
      durationMs <= performanceBudgetMs,
      `${durationMs.toFixed(3)} ms`,
    );
  }
  return assertions;
}

export async function runScenarioSuite(options: ScenarioRunnerOptions): Promise<ScenarioReport> {
  assertSuite(options.suite);
  const measureNow = options.measureNow ?? (() => performance.now());
  const runs: ScenarioRun[] = [];

  for (const scenario of expandedScenarios(options.suite)) {
    const repository = await options.repositoryFactory();
    if (repository.packId !== options.suite.pack.id) {
      await repository.close();
      throw new Error(`Repository pack ${repository.packId} does not match scenario pack ${options.suite.pack.id}`);
    }
    try {
      let resolvedScenario = scenario;
      if (scenario.startAccessPoint) {
        const accessPoints = await repository.getAccessPoints(
          scenario.request.bbox,
          scenario.startAccessPoint.accessState === "unknown" || scenario.request.includeUncertainAccess,
        );
        const selected = accessPoints
          .filter(({ accessState }) => accessState === scenario.startAccessPoint?.accessState)
          .sort((left, right) => left.id.localeCompare(right.id))[0];
        if (!selected) {
          throw new Error(
            `Scenario ${scenario.id} requires a ${scenario.startAccessPoint.accessState} access point inside its rectangle`,
          );
        }
        resolvedScenario = {
          ...scenario,
          request: { ...scenario.request, startAccessPointId: selected.id },
        };
      }
      const solver = createRouteSolver({
        pack: options.suite.pack,
        sourceFreshness: resolvedScenario.sourceFreshness ?? options.suite.pack.builtAt,
      });
      const budget = { ...DEFAULT_SOLVER_BUDGET, ...resolvedScenario.budget };
      const started = measureNow();
      const response = await solver.generate(resolvedScenario.request, { repository, budget });
      const durationMs = Math.max(0, measureNow() - started);
      const assertions = evaluate(response, resolvedScenario, durationMs, options.suite.performanceBudgetMs);
      runs.push({
        id: scenario.runId,
        sourceScenarioId: scenario.id,
        tags: scenario.tags,
        requested: response.requested,
        durationMs,
        exactCount: response.exact.length,
        nearMissCount: response.nearMisses.length,
        routeShapes: [...new Set([...response.exact, ...response.nearMisses].map(({ shape }) => shape))],
        diagnostics: response.diagnostics,
        assertions,
        passed: assertions.every(({ passed }) => passed),
      });
    } finally {
      await repository.close();
    }
  }

  const typicalRuns = runs.filter((run) => run.tags.includes("typical"));
  const passed = runs.filter((run) => run.passed).length;
  return {
    schemaVersion: 1,
    suite: options.suite.name,
    pack: options.suite.pack,
    performanceBudgetMs: options.suite.performanceBudgetMs,
    passed: passed === runs.length,
    summary: {
      scenarioRuns: runs.length,
      passed,
      failed: runs.length - passed,
      typicalRuns: typicalRuns.length,
      slowestTypicalDurationMs: Math.max(0, ...typicalRuns.map(({ durationMs }) => durationMs)),
    },
    scenarios: runs,
  };
}
