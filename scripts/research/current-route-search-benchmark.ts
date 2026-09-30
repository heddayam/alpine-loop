/** Offline schema-7, per-start production-pipeline benchmark. See docs/rebuild/route-search-benchmark.md. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import type { DataRelease, GeneratedClosedRouteV3, RouteCriteria } from "../../lib/contracts";
import type { AccessPointCandidate, AreaGeometry, InducedGraph, ReachableGraphResult } from "../../lib/graph";
import type { PreparedGraphDescriptor } from "../../lib/graph/prepared-repository";
import type { RouteSearchResult } from "../../lib/solver";
import { fixtureCases } from "./solver-benchmark-cases";

const argument = (name: string, fallback: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const integer = (name: string, fallback: number, minimum = 1) => {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid --${name}`);
  return value;
};
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const solverRoot = resolve(argument("solver-root", ownRoot));
const tsconfig = join(solverRoot, "tsconfig.json");
// Bind transitive @/ imports to the measured checkout, not the harness checkout.
if (process.env.TSX_TSCONFIG_PATH !== tsconfig) {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: solverRoot, env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig }, stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const mode = argument("mode", "fixed-work"), suite = argument("suite", "fixtures");
if (!["fixed-work", "deadline"].includes(mode) || !["fixtures", "published", "all"].includes(suite)) throw new Error("Invalid mode or suite");
const repeats = integer("repeats", 2), startCount = integer("starts", 3);
const selectedCases = new RegExp(argument("case", ".*"));
const selectedRegions = argument("regions", "santa-cruz-mountains,snoqualmie-region").split(",");
const output = argument("output", "");
const allowDirty = argument("allow-dirty", "false") === "true";
const moduleUrl = (name: string) => pathToFileURL(join(solverRoot, name)).href;
const { PreparedGraphRepository } = await import(moduleUrl("lib/graph/prepared-repository.ts")) as typeof import("../../lib/graph/prepared-repository");
const { ReachableGraphClosedRouteSolver } = await import(moduleUrl("lib/solver/reachable-graph-closed-route-solver.ts")) as typeof import("../../lib/solver/reachable-graph-closed-route-solver");
const { writeGraphFixture, promoteGraphFixture } = await import(moduleUrl("lib/graph/test-helpers.ts")) as typeof import("../../lib/graph/test-helpers");
const { areaBounds } = await import(moduleUrl("lib/graph/geometry.ts")) as typeof import("../../lib/graph/geometry");
const { dataReleaseSchema } = await import(moduleUrl("lib/contracts/index.ts")) as typeof import("../../lib/contracts");
const { CLOSED_ROUTE_BUDGET } = await import(moduleUrl("lib/solver/budget.ts")) as typeof import("../../lib/solver/budget");
const budget = { ...CLOSED_ROUTE_BUDGET, maximumExpandedStates: integer("expanded-states", mode === "fixed-work" ? 50_000 : CLOSED_ROUTE_BUDGET.maximumExpandedStates),
  deadlineMs: integer("deadline-ms", CLOSED_ROUTE_BUDGET.deadlineMs) };
const now = mode === "fixed-work" ? () => 0 : Date.now;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sourceFiles = () => ["lib/solver", "lib/graph"].flatMap(folder => readdirSync(join(solverRoot, folder)).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort().map(name => [join(folder, name), readFileSync(join(solverRoot, folder, name), "utf8")]));
const sourceFingerprint = hash(sourceFiles());
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: solverRoot, encoding: "utf8" }).trim();
const sourceWorkingTreeChanges = execFileSync("git", ["status", "--porcelain", "--", "lib/graph", "lib/solver"], { cwd: solverRoot, encoding: "utf8" }).trim();
if (sourceWorkingTreeChanges && !allowDirty) {
  throw new Error("Benchmark a committed, stable graph/solver checkout");
}
const directory = mkdtempSync(join(tmpdir(), "alpine-current-search-benchmark-"));

type Case = { id: string; descriptor: PreparedGraphDescriptor; builtAt: string; criteria: RouteCriteria;
  startGeometry: AreaGeometry; artifactHash: string; starts: AccessPointCandidate[] };

function summarizeRoute(route: GeneratedClosedRouteV3, criteria: RouteCriteria) {
  return { id: route.id, physicalLoopId: route.physicalLoopId ?? null, geometryFingerprint: hash(route.geometry),
    distanceMeters: route.distanceMeters, gainMeters: route.elevationGainMeters,
    targetDistanceDeviationMeters: Math.abs(route.distanceMeters - (criteria.distanceMiles.min + criteria.distanceMiles.max) * 1609.344 / 2),
    targetGainDeviationMeters: criteria.elevationGainFeet ? Math.abs(route.elevationGainMeters - (criteria.elevationGainFeet.min + criteria.elevationGainFeet.max) * 0.3048 / 2) : null,
    repeatedTrailMeters: route.topology.repeatedTrailDistanceMeters, repeatedTrailFraction: route.topology.repeatedTrailFraction,
    sharedStemMeters: route.topology.sharedStemDistanceMeters, topology: route.topology.kind,
    gradeExperience: route.gradeExperience ?? null };
}
function summarize(result: RouteSearchResult, criteria: RouteCriteria) {
  // Match the saved Full-search policy: ten exact routes, otherwise one close match.
  const exact = result.exact.slice(0, 10).map(route => summarizeRoute(route, criteria));
  const near = exact.length ? [] : result.nearMisses.slice(0, 1).map(route => ({ ...summarizeRoute(route, criteria), violations: route.violations }));
  const stableDiagnostics = Object.fromEntries(Object.entries(result.diagnostics).filter(([key]) => !key.endsWith("Ms")));
  return { exact, near, exactCount: exact.length, nearCount: near.length,
    distinctPhysicalLoops: new Set(exact.flatMap(route => route.physicalLoopId ? [route.physicalLoopId] : [])).size,
    missingPhysicalLoopIds: exact.filter(route => !route.physicalLoopId).length,
    meanTargetDistanceDeviationMeters: mean(exact.map(route => route.targetDistanceDeviationMeters)),
    meanSharedStemMeters: mean(exact.map(route => route.sharedStemMeters)),
    resultFingerprint: hash({ exact, near, diagnostics: stableDiagnostics }), diagnostics: result.diagnostics };
}

async function chooseStarts(descriptor: PreparedGraphDescriptor, startGeometry: AreaGeometry, minimumComponentKm = 0) {
  const repository = new PreparedGraphRepository(descriptor);
  try {
    const candidates = (await repository.getAccessPointCandidates({ bbox: areaBounds(startGeometry), includeUncertainAccess: true }))
      .filter(point => point.inclusiveMinimumStemMeters !== null && point.inclusiveMinimumStemMeters !== undefined
        && (point.reachableTrailKm ?? 0) >= minimumComponentKm)
      .sort((a, b) => b.inclusiveConnectivity - a.inclusiveConnectivity || (a.inclusiveMinimumStemMeters ?? Infinity) - (b.inclusiveMinimumStemMeters ?? Infinity) || a.id.localeCompare(b.id));
    const onCycle = candidates.filter(point => point.inclusiveMinimumStemMeters === 0);
    const approaches = candidates.filter(point => (point.inclusiveMinimumStemMeters ?? Infinity) > 0 && point.inclusiveMinimumStemMeters! <= 1609.344)
      .sort((a, b) => a.inclusiveMinimumStemMeters! - b.inclusiveMinimumStemMeters! || b.inclusiveConnectivity - a.inclusiveConnectivity || a.id.localeCompare(b.id));
    // Predeclared topology strata, independent of either solver's results.
    const priority = [onCycle[0], onCycle[Math.floor(onCycle.length / 2)], approaches[0], ...candidates];
    return [...new Map(priority.filter((point): point is AccessPointCandidate => !!point).map(point => [point.id, point])).values()].slice(0, startCount);
  } finally { await repository.close(); }
}

async function measure(item: Case) {
  const openingStarted = performance.now();
  const repository = new PreparedGraphRepository(item.descriptor);
  const repositoryInitializationMs = performance.now() - openingStarted;
  let phaseWall = performance.now(), phases = { graph: 0, generation: 0, validation: 0 };
  let observedRssBytes = process.memoryUsage().rss;
  let loaded: ReachableGraphResult[] = [];
  const sampleMemory = () => { observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss); };
  const originalRead = repository.getReachableGraph.bind(repository);
  repository.getReachableGraph = async query => {
    const started = performance.now();
    try { const result = await originalRead(query); loaded.push(result); return result; }
    finally { phases.graph += performance.now() - started; sampleMemory(); }
  };
  const solver = new ReachableGraphClosedRouteSolver({
    pack: { id: item.descriptor.installationId, dataVersion: item.descriptor.releaseId, builtAt: item.builtAt },
    onPhaseTiming(phase) {
      const timestamp = performance.now();
      if (phase !== "graph") phases[phase] += timestamp - phaseWall;
      phaseWall = timestamp; sampleMemory();
    },
  });
  try {
    const preparationStarted = performance.now();
    const prepared = await solver.prepare(item.criteria, { repository, accessFilter: { predicates: [item.startGeometry], coverage: item.descriptor.coverage }, now });
    const preparationMs = performance.now() - preparationStarted;
    if (item.starts.some(start => !prepared.eligibleAccessPointIds.includes(start.id))) throw new Error(`Selected start became ineligible: ${item.id}`);
    const samples: Array<ReturnType<typeof summarize> & { pass: number; startId: string; elapsedMs: number; otherWallMs: number;
      phaseWallMs: typeof phases; observedRssBytes: number; graphs: Array<{ nodes: number; directedEdges: number; truncated: boolean; fingerprint: string }> }> = [];
    for (let pass = 0; pass < repeats; pass++) for (const start of item.starts) {
      phases = { graph: 0, generation: 0, validation: 0 }; loaded = [];
      observedRssBytes = process.memoryUsage().rss;
      phaseWall = performance.now(); const started = phaseWall;
      const result = await prepared.generate({ limit: 10, startAccessPointId: start.id }, budget);
      const elapsedMs = performance.now() - started; sampleMemory();
      // Hashing happens after timing/deadlines, so it cannot steal search budget.
      const graphSummaries = loaded.map(({ graph, truncated }) => ({ nodes: graph.nodes.size, directedEdges: graph.edges.length, truncated,
        fingerprint: hash({ nodes: [...graph.nodes], edges: graph.edges }) }));
      samples.push({ pass, startId: start.id, elapsedMs, phaseWallMs: phases,
        otherWallMs: Math.max(0, elapsedMs - phases.graph - phases.generation - phases.validation), observedRssBytes,
        graphs: graphSummaries, ...summarize(result, item.criteria) });
      console.error(`${item.id} pass=${pass} start=${start.id}: ${elapsedMs.toFixed(0)}ms exact=${result.exact.length} ${result.diagnostics.hardTruncationReasons.join(",")}`);
    }
    const times = samples.map(sample => sample.elapsedMs);
    const uniqueLoops = (pass: number) => new Set(samples.filter(sample => sample.pass === pass)
      .flatMap(sample => sample.exact.flatMap(route => route.physicalLoopId ? [route.physicalLoopId] : []))).size;
    return { id: item.id, artifactHash: item.artifactHash,
      inputFingerprint: hash({ artifactHash: item.artifactHash, criteria: item.criteria, starts: item.starts, budget, startGeometry: item.startGeometry, coverage: item.descriptor.coverage }),
      criteria: item.criteria, starts: item.starts, eligibleStarts: prepared.eligibleAccessPointIds.length,
      repositoryInitializationMs, preparationMs, medianMs: median(times), minimumMs: Math.min(...times), maximumMs: Math.max(...times),
      distinctPhysicalLoopsByPass: Array.from({ length: repeats }, (_, pass) => uniqueLoops(pass)), samples };
  } finally { await repository.close(); }
}

async function unpackArtifact(releasePath: string, artifact: DataRelease["artifacts"][number]) {
  const compressed = resolve(dirname(releasePath), artifact.path);
  if (!compressed.endsWith(".sqlite.gz") || statSync(compressed).size !== artifact.compressedBytes) throw new Error(`Invalid sealed object: ${artifact.id}`);
  const destination = join(directory, `${artifact.id}.sqlite`);
  const digest = createHash("sha256"); let bytes = 0;
  await pipeline(createReadStream(compressed), createGunzip(), new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length; digest.update(chunk); callback(null, chunk);
  } }), createWriteStream(destination, { flags: "wx" }));
  if (bytes !== artifact.bytes || digest.digest("hex") !== artifact.id) throw new Error(`Artifact hash/size mismatch: ${artifact.id}`);
  return destination;
}

const cases: Case[] = [];
try {
  if (suite !== "fixtures") {
    const releasePath = resolve(argument("release", join(ownRoot, ".local-data/releases/prepared/release.json")));
    if (!existsSync(releasePath)) throw new Error("Published suite needs --release=/path/to/sealed/release.json");
    const release = dataReleaseSchema.parse(JSON.parse(readFileSync(releasePath, "utf8")));
    if (release.graphSchemaVersion !== "7") throw new Error("Expected schema-7 published artifacts");
    for (const regionId of selectedRegions) {
      const artifact = release.artifacts.find(value => value.regionId === regionId);
      if (!artifact?.startGeometry) throw new Error(`No independent start-area artifact for ${regionId}`);
      const path = await unpackArtifact(releasePath, artifact);
      const descriptor: PreparedGraphDescriptor = { releaseId: release.id, installationId: `benchmark-${artifact.id}`, coverage: artifact.geometry,
        artifacts: [{ path, geometry: artifact.geometry, startGeometry: artifact.startGeometry, regionId, graphId: artifact.graphId }] };
      const starts = await chooseStarts(descriptor, artifact.startGeometry, 5);
      if (!starts.length) throw new Error(`No cycle-reachable starts: ${regionId}`);
      for (const repeat of [0, 35]) {
        const id = `published/${regionId}/repeat-${repeat}`;
        if (selectedCases.test(id)) cases.push({ id, descriptor, artifactHash: artifact.id, startGeometry: artifact.startGeometry,
          builtAt: release.builtAt, starts, criteria: { distanceMiles: { min: 3, max: 8 }, closedRoute: { maximumRepeatedTrailPct: repeat }, includeUncertainAccess: true } });
      }
    }
  }
  if (suite !== "published") {
    for (const [index, source] of fixtureCases(ownRoot).entries()) {
      if (!selectedCases.test(source.id)) continue;
      const path = join(directory, `fixture-${index}.sqlite`);
      // Retain the shared fixture's topology, but use complete, non-flat profiles.
      const graph: InducedGraph = structuredClone(source.graph);
      [...graph.nodes.values()].forEach((node, i) => { node.elevationMeters = 100 + (i * 7) % 45; });
      for (const edge of graph.edges) {
        const rise = graph.nodes.get(edge.toNodeId)!.elevationMeters! - graph.nodes.get(edge.fromNodeId)!.elevationMeters!;
        edge.gainMeters = Math.max(0, rise); edge.lossMeters = Math.max(0, -rise);
        edge.maximumElevationMeters = Math.max(graph.nodes.get(edge.toNodeId)!.elevationMeters!, graph.nodes.get(edge.fromNodeId)!.elevationMeters!);
        edge.maximumSustainedGradePct = Math.abs(rise / edge.lengthMeters * 100);
      }
      if (source.id === "fixture/grid-8") for (const nodeId of ["n1", "n8"]) {
        const node = graph.nodes.get(nodeId)!;
        graph.accessPoints.push({ ...source.start, id: `access-${nodeId}`, nodeId, name: `Shared grid start ${nodeId}` });
        if (!node) throw new Error("Missing grid start");
      }
      const manifest = writeGraphFixture(path, graph);
      promoteGraphFixture(path, manifest.dataVersion);
      const coverage: AreaGeometry = { type: "Polygon", coordinates: [[[-123, 36], [-121, 36], [-121, 38], [-123, 38], [-123, 36]]] };
      const descriptor: PreparedGraphDescriptor = { releaseId: manifest.dataVersion, installationId: manifest.id, coverage,
        artifacts: [{ path, geometry: coverage, startGeometry: coverage }] };
      const starts = await chooseStarts(descriptor, coverage);
      const { distanceMiles, closedRoute, includeUncertainAccess, elevationGainFeet, maximumElevationFeet, steepestSustainedGradePct, gradeExperience } = source.request;
      const criteria: RouteCriteria = { distanceMiles, closedRoute, includeUncertainAccess, elevationGainFeet, maximumElevationFeet, steepestSustainedGradePct, gradeExperience };
      if (starts.length) cases.push({ id: source.id, descriptor, builtAt: manifest.builtAt, artifactHash: hash({ nodes: [...graph.nodes], edges: graph.edges, accessPoints: graph.accessPoints }), startGeometry: coverage, starts, criteria });
    }
  }
  if (!cases.length) throw new Error("No matching cases");
  const measurements = [];
  for (const item of cases) measurements.push(await measure(item));
  const sourceChangedDuringMeasurement = hash(sourceFiles()) !== sourceFingerprint
    || execFileSync("git", ["rev-parse", "HEAD"], { cwd: solverRoot, encoding: "utf8" }).trim() !== commit;
  if (sourceChangedDuringMeasurement && !allowDirty) {
    throw new Error("Measured checkout changed during the benchmark; discard these samples and rerun");
  }
  const report = { formatVersion: 1, solverRoot, commit, solverSourceFingerprint: sourceFingerprint,
    provisional: !!sourceWorkingTreeChanges || sourceChangedDuringMeasurement, sourceWorkingTreeChanges, sourceChangedDuringMeasurement, node: process.version,
    mode, suite, repeats, budget, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    notes: ["PreparedGraphRepository schema 7; serial per-start prepared search, not the job worker scheduler.",
      "Pass zero starts with a new reader cache; later starts and passes can reuse rows. OS file caches are not flushed.",
      "Fixed-work disables the solver clock; the graph reader retains its real safety timeout. A graph-timeout case is not an equal-work comparison.",
      "Phase wall times are measured externally; generation/validation include the small interval between their existing phase hooks.",
      "Only selected starts are sampled. Route retention and finite budgets do not establish exhaustive loop enumeration."], cases: measurements };
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, serialized); }
  else console.log(serialized);
} finally { rmSync(directory, { recursive: true, force: true }); }
