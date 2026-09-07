/** Offline solver comparison; fixtures need no installed pack or network.
 * node --import tsx scripts/research/solver-benchmark.ts --solver-root=. --suite=fixtures --mode=fixed-work
 * Add --suite=packs --data-root=/path/to/.local-data for the first reviewed start in each installed pack.
 * --search-module=/absolute/prototype.ts substitutes candidate search in both layers (Node 22.15+).
 * --scenario-index=1 selects a different committed regional scenario for a holdout comparison.
 * Compare identical inputFingerprint values. Fixed-work disables solver clock deadlines, retains all
 * work caps, and measures performance.now externally; deadline mode measures the production policy.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import type { PackManifest, GeneratedClosedRouteV3 } from "../../lib/contracts";
import type { EdgeTraversal } from "../../lib/graph";
import type { ResolvedAccessFilterContext, RouteSearchRequest, RouteSearchResult } from "../../lib/solver";
import type { PenalizedClosedRouteCandidate, PenalizedClosedRouteSearchResult } from "../../lib/solver/penalized-closed-route-search";
import { fixtureCases, request, type BenchmarkCase } from "./solver-benchmark-cases";

const argument = (name: string, fallback: string): string =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const solverRoot = resolve(argument("solver-root", ownRoot));
const tsconfig = join(solverRoot, "tsconfig.json");
// A fresh tsx loader binds @/ imports to the requested checkout, including transitive imports.
if (process.env.TSX_TSCONFIG_PATH !== tsconfig) {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: solverRoot, env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig }, stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const mode = argument("mode", "fixed-work");
const suite = argument("suite", "fixtures");
const layer = argument("layer", "both");
const effort = argument("effort", "quick");
if (!["fixed-work", "deadline"].includes(mode) || !["fixtures", "packs", "all"].includes(suite)
  || !["raw", "pipeline", "both"].includes(layer) || (effort !== "quick" && effort !== "thorough")) {
  throw new Error("Expected --mode=fixed-work|deadline --suite=fixtures|packs|all --layer=raw|pipeline|both --effort=quick|thorough");
}
const integer = (name: string, fallback: string, min = 0): number => {
  const value = Number(argument(name, fallback));
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid --${name}`);
  return value;
};
const warmup = integer("warmup", "1");
const repeats = integer("repeats", "3", 1);
const scenarioIndex = integer("scenario-index", "0");
const casePattern = new RegExp(argument("case", ".*"));
const dataRoot = resolve(argument("data-root", join(ownRoot, ".local-data")));
const output = argument("output", "");
const moduleUrl = (path: string): string => pathToFileURL(join(solverRoot, path)).href;
// Research-only substitution, including the unchanged production pipeline. Node 22.15+.
const searchModule = resolve(argument("search-module", join(solverRoot, "lib/solver/penalized-closed-route-search.ts")));
const searchModuleUrl = pathToFileURL(searchModule).href;
let pipelineSubstitutions = 0;
const substitution = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.split("?")[0] === moduleUrl("lib/solver/reachable-graph-closed-route-solver.ts")
    && /(?:^|\/)penalized-closed-route-search(?:\.ts)?$/.test(specifier)) {
    pipelineSubstitutions += 1;
    return nextResolve(searchModuleUrl, context);
  }
  return nextResolve(specifier, context);
} });
const { searchPenalizedClosedRoutes } = await import(searchModuleUrl) as typeof import("../../lib/solver/penalized-closed-route-search");
const { ReachableGraphClosedRouteSolver } = await import(moduleUrl("lib/solver/reachable-graph-closed-route-solver.ts")) as typeof import("../../lib/solver/reachable-graph-closed-route-solver");
const { CLOSED_ROUTE_EFFORT_BUDGETS } = await import(moduleUrl("lib/solver/budget.ts")) as typeof import("../../lib/solver/budget");
const { SQLiteGraphRepository, SQLiteClosedRouteFeasibilityRepository, distanceMetersBetween, edgeIsTraversable } = await import(moduleUrl("lib/graph/index.ts")) as typeof import("../../lib/graph");
const contractionPath = "lib/solver/contract-corridors.ts";
const contraction = existsSync(join(solverRoot, contractionPath)) ? await import(moduleUrl(contractionPath)) as {
  contractCorridors: (edges: EdgeTraversal[], startNodeId: string) => EdgeTraversal[][];
} : undefined;
const { writeGraphFixture } = await import(moduleUrl("lib/graph/test-helpers.ts")) as typeof import("../../lib/graph/test-helpers");
const { packManifestSchema } = await import(moduleUrl("lib/contracts/index.ts")) as typeof import("../../lib/contracts");
const { listEligibleAccessPointCandidates } = await import(moduleUrl("lib/solver/eligible-access-points.ts")) as typeof import("../../lib/solver/eligible-access-points");
const { getSearchRegion } = await import(moduleUrl("lib/data/named-area-catalog.ts")) as typeof import("../../lib/data/named-area-catalog");
const budget = { ...CLOSED_ROUTE_EFFORT_BUDGETS[effort], deadlineMs: integer("deadline-ms", String(CLOSED_ROUTE_EFFORT_BUDGETS[effort].deadlineMs), 1) };
const now = mode === "fixed-work" ? () => 0 : Date.now;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableDiagnostics = (value: object): object => Object.fromEntries(Object.entries(value)
  .filter(([key]) => !key.endsWith("Ms")));
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const mean = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function summarizeRoute(route: PenalizedClosedRouteCandidate | GeneratedClosedRouteV3, target: RouteSearchRequest) {
  const raw = "traversals" in route;
  const fingerprint = hash(raw ? route.traversals.map(({ edge }) => edge.edgeKey ?? edge.id) : route.geometry);
  const center = (target.distanceMiles.min + target.distanceMiles.max) * 1609.344 / 2;
  return {
    id: route.id, fingerprint, distanceMeters: route.distanceMeters, elevationGainMeters: route.elevationGainMeters,
    targetDistanceDeviationMeters: Math.abs(route.distanceMeters - center),
    targetDistanceDeviationFraction: Math.abs(route.distanceMeters - center) / center,
    repeatedTrailFraction: raw ? route.repeatedEdgeFraction : route.topology.repeatedTrailFraction,
    ...(raw ? { score: route.score, violations: route.violatedConstraints } : {
      topology: route.topology, violations: "violations" in route ? route.violations : [],
    }),
  };
}

function summarize(result: PenalizedClosedRouteSearchResult | RouteSearchResult, target: RouteSearchRequest) {
  const exact = ("candidates" in result ? result.candidates : result.exact).map((route) => summarizeRoute(route, target));
  const near = ("nearCandidates" in result ? result.nearCandidates : result.nearMisses).map((route) => summarizeRoute(route, target));
  const diagnostics = stableDiagnostics(result.diagnostics);
  return {
    resultFingerprint: hash({ exact, near, diagnostics }), exactCount: exact.length, nearCount: near.length,
    firstExactTargetDeviationMeters: exact[0]?.targetDistanceDeviationMeters ?? null,
    firstExactRepeatedTrailFraction: exact[0]?.repeatedTrailFraction ?? null,
    bestExactTargetDeviationMeters: exact.length ? Math.min(...exact.map((route) => route.targetDistanceDeviationMeters)) : null,
    meanTopThreeExactTargetDeviationMeters: mean(exact.slice(0, 3).map((route) => route.targetDistanceDeviationMeters)),
    meanTopThreeExactRepeatedTrailFraction: mean(exact.slice(0, 3).map((route) => route.repeatedTrailFraction)),
    meanExactTargetDeviationMeters: mean(exact.map((route) => route.targetDistanceDeviationMeters)),
    meanExactRepeatedTrailFraction: mean(exact.map((route) => route.repeatedTrailFraction)),
    exact, near, diagnostics,
  };
}

async function measure(id: string, target: RouteSearchRequest, run: () => Promise<RouteSearchResult> | PenalizedClosedRouteSearchResult) {
  for (let index = 0; index < warmup; index += 1) await run();
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const startedAt = performance.now();
    const result = await run();
    const elapsedMs = performance.now() - startedAt;
    samples.push({ elapsedMs, ...summarize(result, target) });
  }
  const times = samples.map(({ elapsedMs }) => elapsedMs);
  const medianMs = median(times);
  console.error(`${id}: ${medianMs.toFixed(2)}ms, exact=${samples.map((sample) => sample.exactCount).join(",")}, near=${samples.map((sample) => sample.nearCount).join(",")}`);
  return { id, medianMs, minimumMs: Math.min(...times), maximumMs: Math.max(...times),
    deterministic: new Set(samples.map(({ resultFingerprint }) => resultFingerprint)).size === 1, samples };
}

type PreparedCase = BenchmarkCase & {
  manifest: PackManifest;
  repository: InstanceType<typeof SQLiteGraphRepository>;
  topologyRepository: InstanceType<typeof SQLiteClosedRouteFeasibilityRepository>;
  accessFilter: ResolvedAccessFilterContext;
};

async function runCase(item: PreparedCase) {
  const target: RouteSearchRequest = { ...item.request, startAccessPointId: item.start.id, searchEffort: effort as RouteSearchRequest["searchEffort"] };
  const chains = contraction?.contractCorridors(item.graph.edges.filter((edge) => edgeIsTraversable(edge, target.includeUncertainAccess))
    .map((edge) => ({ edge, from: item.graph.nodes.get(edge.fromNodeId)!, to: item.graph.nodes.get(edge.toNodeId)! }))
    .sort((a, b) => a.edge.id.localeCompare(b.edge.id) || a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id)), item.start.nodeId);
  const contracted = chains ? { directedCorridors: chains.length,
    nodes: new Set(chains.flatMap((chain) => [chain[0]!.from.id, chain.at(-1)!.to.id])).size,
    maximumEdgesPerCorridor: Math.max(0, ...chains.map((chain) => chain.length)) } : undefined;
  const inputFingerprint = hash({ graph: { nodes: [...item.graph.nodes], edges: item.graph.edges }, start: item.start,
    target, budget, dataVersion: item.manifest.dataVersion, accessFilter: item.accessFilter });
  const runs = [];
  if (layer !== "pipeline") runs.push(await measure(`${item.id}/raw`, target,
    () => searchPenalizedClosedRoutes(item.graph, item.start, target, { budget, now })));
  if (layer !== "raw") {
    const solver = new ReachableGraphClosedRouteSolver({ pack: item.manifest });
    runs.push(await measure(`${item.id}/pipeline`, target, () => solver.generate(target, {
      repository: item.repository, topologyRepository: item.topologyRepository, accessFilter: item.accessFilter, budget, now,
    })));
  }
  return { id: item.id, inputFingerprint, pack: { id: item.manifest.id, dataVersion: item.manifest.dataVersion },
    graph: { nodes: item.graph.nodes.size, directedEdges: item.graph.edges.length, truncated: item.graphTruncated ?? false, contracted }, start: item.start,
    request: target, runs };
}

const directory = mkdtempSync(join(tmpdir(), "alpine-solver-benchmark-"));
const cases: Awaited<ReturnType<typeof runCase>>[] = [];
const skipped: string[] = [];
try {
  if (suite !== "packs") for (const [index, item] of fixtureCases(ownRoot).entries()) {
    if (!casePattern.test(item.id)) continue;
    const databasePath = join(directory, `fixture-${index}.sqlite`);
    const manifest = writeGraphFixture(databasePath, item.graph, [item.start]);
    const repository = new SQLiteGraphRepository(databasePath, manifest.id);
    const topologyRepository = new SQLiteClosedRouteFeasibilityRepository({ databasePath, manifest });
    try {
      cases.push(await runCase({ ...item, manifest, repository, topologyRepository,
        accessFilter: { predicates: [manifest.coverage.boundary], coverage: manifest.coverage.boundary } }));
    } finally {
      await topologyRepository.close();
      await repository.close();
    }
  }
  if (suite !== "fixtures") for (const packId of ["santa-cruz-mountains", "henry-coe", "southern-east-bay", "monterey-carmel", "central-cascades"]) {
    const casePrefix = `pack/${packId}${scenarioIndex ? `/scenario-${scenarioIndex}` : ""}`;
    if (!casePattern.test(`${casePrefix}/exact`) && !casePattern.test(`${casePrefix}/near`)) continue;
    const packRoot = join(dataRoot, "packs", packId);
    if (!existsSync(join(packRoot, "current.json"))) { skipped.push(`${packId}: not installed`); continue; }
    const current = JSON.parse(readFileSync(join(packRoot, "current.json"), "utf8")) as { path: string };
    const manifestPath = join(packRoot, current.path);
    const manifest = packManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const databasePath = join(dirname(manifestPath), "pack.sqlite");
    const repository = new SQLiteGraphRepository(databasePath, packId);
    const topologyRepository = new SQLiteClosedRouteFeasibilityRepository({ databasePath, manifest });
    try {
      const scenariosPath = join(ownRoot, "data/regions", packId, "scenarios.json");
      const scenario = existsSync(scenariosPath) ? (JSON.parse(readFileSync(scenariosPath, "utf8")) as { scenarios: Array<{
        searchRegionId: string; referencePoint: { coordinates: [number, number] }; maximumRepeatedTrailPct?: number;
        exactExpectation: Pick<RouteSearchRequest, "distanceMiles" | "elevationGainFeet">;
        impossibleExpectation: Pick<RouteSearchRequest, "distanceMiles" | "elevationGainFeet">;
      }> }).scenarios[scenarioIndex] : undefined;
      if (scenarioIndex && !scenario) { skipped.push(`${packId}: no scenario ${scenarioIndex}`); continue; }
      const region = scenario ? getSearchRegion(databasePath, scenario.searchRegionId) : undefined;
      if (scenario && !region) throw new Error(`Missing reviewed region ${scenario.searchRegionId}`);
      const accessFilter = { predicates: [region?.geometry ?? manifest.coverage.boundary],
        ...(region ? { namedRegionPredicateIndex: 0 } : {}), coverage: manifest.coverage.boundary };
      const { eligible } = await listEligibleAccessPointCandidates({ repository, accessFilter, includeUncertainAccess: true });
      const start = scenario ? eligible.sort((a, b) => distanceMetersBetween([a.lon, a.lat], scenario.referencePoint.coordinates)
        - distanceMetersBetween([b.lon, b.lat], scenario.referencePoint.coordinates) || a.id.localeCompare(b.id))[0]
        : eligible.filter(({ name }) => /fall creek/i.test(name)).sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!start) throw new Error(`No benchmark start for ${packId}`);
      for (const kind of ["exact", "near"] as const) {
        const id = `${casePrefix}/${kind}`;
        if (!casePattern.test(id)) continue;
        const expectation = kind === "exact" ? scenario?.exactExpectation : scenario?.impossibleExpectation;
        const target = request({ ...(expectation ?? (kind === "exact"
          ? { distanceMiles: { min: 4, max: 10 }, elevationGainFeet: { min: 500, max: 3500 } }
          : { distanceMiles: { min: 1, max: 2 }, elevationGainFeet: { min: 8000, max: 9000 } })),
        closedRoute: { maximumRepeatedTrailPct: scenario?.maximumRepeatedTrailPct ?? 35, allowMultiCycle: true } });
        const { graph, truncated } = await repository.getReachableGraph({ startNodeId: start.nodeId,
          maximumDistanceMeters: target.distanceMiles.max * 1609.344, maximumDirectedEdges: budget.maximumDirectedEdges,
          includeUncertainAccess: true, coverage: manifest.coverage.boundary });
        cases.push(await runCase({ id, graph, graphTruncated: truncated, start, request: target, manifest, repository, topologyRepository, accessFilter }));
      }
    } finally {
      await topologyRepository.close();
      await repository.close();
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
if (!cases.length) throw new Error("No matching benchmark cases; inspect --suite, --case, and --data-root");
const sourceFiles = ["lib/solver", "lib/graph"].flatMap((folder) => readdirSync(join(solverRoot, folder))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).sort()
  .map((file) => [join(folder, file), readFileSync(join(solverRoot, folder, file), "utf8")]));
const report = { formatVersion: 1, solverRoot,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: solverRoot, encoding: "utf8" }).trim(),
  solverSourceFingerprint: hash(sourceFiles), searchModule, searchModuleFingerprint: hash(readFileSync(searchModule, "utf8")),
  pipelineSubstitutions, node: process.version, mode, suite, layer, effort, scenarioIndex, warmup, repeats, budget,
  notes: ["Raw inputs are loaded before timing; pipeline timing includes SQLite reads and validation.",
    "Target deviation is descriptive, not a complete measure of hike quality. Compare exact counts, diversity, topology, repetition and violations together.",
    "Fixed-work retains expansion and candidate caps. Run benchmarks serially on an idle machine."],
  skipped, cases };
substitution.deregister();
if (pipelineSubstitutions !== 1) throw new Error(`Expected one pipeline search-module substitution; saw ${pipelineSubstitutions}`);
const serialized = JSON.stringify(report, null, 2) + "\n";
if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, serialized); }
else console.log(serialized);
