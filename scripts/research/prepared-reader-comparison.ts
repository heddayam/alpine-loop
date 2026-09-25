/**
 * Offline fixed-work comparison on the SAME graph, with no source acquisition.
 * node --import tsx scripts/research/prepared-reader-comparison.ts input.json output.json
 * Input: { baselinePath, baselinePackId, prepared: PreparedGraphDescriptor,
 *   accessPointIds?: string[], maximumStarts?: number, repetitions?: number,
 *   criteria?: RouteCriteria }
 * Export prepared pieces from a COPY of baselinePath after promoting its hints;
 * this command never writes either graph. Do not compare independently rebuilt data.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { areaBounds, PreparedGraphRepository, type PreparedGraphDescriptor, type GraphRepository, type InducedGraph } from "@/lib/graph";
import { SQLiteGraphRepository } from "@/lib/graph/sqlite-repository";
import { CLOSED_ROUTE_EFFORT_BUDGETS, listEligibleAccessPointCandidates, ReachableGraphClosedRouteSolver, type RouteSearchResult } from "@/lib/solver";
import type { RouteCriteria } from "@/lib/contracts";

type Input = {
  baselinePath: string;
  baselinePackId: string;
  prepared: PreparedGraphDescriptor;
  accessPointIds?: string[];
  maximumStarts?: number;
  repetitions?: number;
  criteria?: RouteCriteria;
};
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: prepared-reader-comparison.ts input.json output.json");
const input = JSON.parse(await readFile(inputPath, "utf8")) as Input;
const baseline = new SQLiteGraphRepository(input.baselinePath, input.baselinePackId);
const prepared = new PreparedGraphRepository({ ...input.prepared, installationId: input.baselinePackId });
const metadataDatabase = new DatabaseSync(input.baselinePath, { readOnly: true });
const metadata = new Map(metadataDatabase.prepare("SELECT key,value FROM metadata").all().map(row => [String(row.key), String(row.value)]));
metadataDatabase.close();
const criteria: RouteCriteria = input.criteria ?? {
  distanceMiles: { min: 3, max: 15 }, includeUncertainAccess: true,
  closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
};
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const graphFingerprint = (graph: InducedGraph) => fingerprint({
  nodes: [...graph.nodes].sort(([a], [b]) => a.localeCompare(b)),
  edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
});
const resultFingerprint = (result: RouteSearchResult) => fingerprint({
  ...result, diagnostics: { ...result.diagnostics, elapsedMs: 0, timeToFirstExactMs: 0 },
});
const fullPayload = (quick: RouteSearchResult, thorough: RouteSearchResult) => {
  const unique = <T extends { id: string }>(rows: T[]) => {
    const seen = new Set<string>();
    return rows.filter(row => !seen.has(row.id) && Boolean(seen.add(row.id)));
  };
  return {
    exact: unique([...quick.exact, ...thorough.exact]).slice(0, 10),
    nearMisses: unique([...thorough.nearMisses, ...quick.nearMisses]),
    truncated: [quick, thorough].some(result => result.diagnostics.hardTruncationReasons.length > 0),
  };
};
const rows: unknown[] = [];
let comparisons = 0, mismatches = 0;
try {
  const query = { bbox: areaBounds(input.prepared.coverage), includeUncertainAccess: criteria.includeUncertainAccess };
  const candidates = (await listEligibleAccessPointCandidates({ repository: baseline, accessFilter: { predicates: [input.prepared.coverage], coverage: input.prepared.coverage }, includeUncertainAccess: criteria.includeUncertainAccess })).eligible;
  const selected = candidates.filter(point => input.accessPointIds
    ? input.accessPointIds.includes(point.id)
    : (criteria.includeUncertainAccess ? point.inclusiveMinimumStemMeters : point.knownMinimumStemMeters) !== null)
    .slice(0, input.maximumStarts ?? 8);
  if (!selected.length) throw new Error("No requested fixture starts were found");
  if (input.accessPointIds?.some(id => !selected.some(point => point.id === id))) throw new Error("Some requested starts were not selected; increase maximumStarts or check identities");
  const preparedPoints = await prepared.getAccessPointCandidates(query);
  for (const point of selected) {
    const current = preparedPoints.find(candidate => candidate.id === point.id);
    if (fingerprint(point) !== fingerprint(current)) throw new Error(`Same-graph precondition failed: candidate ${point.id} differs`);
    for (const effort of ["quick", "thorough"] as const) {
      const reachable = { startNodeId: point.nodeId, startCoordinates: [point.lon, point.lat] as const,
        maximumDistanceMeters: criteria.distanceMiles.max * 1609.344,
        maximumDirectedEdges: CLOSED_ROUTE_EFFORT_BUDGETS[effort].maximumDirectedEdges,
        includeUncertainAccess: criteria.includeUncertainAccess, coverage: input.prepared.coverage };
      const old = await baseline.getReachableGraph(reachable), next = await prepared.getReachableGraph(reachable);
      if (old.truncated !== next.truncated || graphFingerprint(old.graph) !== graphFingerprint(next.graph)) {
        throw new Error(`Same-graph precondition failed: ${effort} reachable graph/keys/metrics at ${point.id} differ`);
      }
    }
  }
  const repetitions = Math.max(1, Math.min(20, input.repetitions ?? 3));
  for (let repetition = 0; repetition < repetitions; repetition++) for (const point of selected) {
    const outcomes = new Map<string, { quick: RouteSearchResult; thorough: RouteSearchResult }>();
    // Alternate order to reduce warm-filesystem and JIT bias. Handle caches stay bounded.
    const readers: Array<[string, GraphRepository]> = [["baseline", baseline], ["prepared", prepared]];
    if (repetition % 2) readers.reverse();
    for (const [reader, repository] of readers) {
      const solver = new ReachableGraphClosedRouteSolver({
        pack: { id: repository.packId, dataVersion: metadata.get("dataVersion") ?? "comparison", builtAt: metadata.get("builtAt")! },
        sourceFreshness: metadata.get("builtAt"), sourceConfidence: "high", fallbackSourceIds: ["comparison"],
      });
      // Freeze the solver's clock for identical state/candidate budgets. Graph I/O
      // retains its real deadline and aborts honestly if a reader exceeds it.
      const context = { repository, accessFilter: { predicates: [], coverage: input.prepared.coverage }, now: () => 0 };
      const results: RouteSearchResult[] = [];
      const elapsed: number[] = [];
      for (const searchEffort of ["quick", "thorough"] as const) {
        const begin = performance.now();
        results.push(await solver.generate({ ...criteria, searchEffort, limit: 10, startAccessPointId: point.id },
          { ...context, budget: CLOSED_ROUTE_EFFORT_BUDGETS[searchEffort] }));
        elapsed.push(performance.now() - begin);
      }
      const [quick, thorough] = results;
      outcomes.set(reader, { quick, thorough });
      rows.push({ repetition, start: point.id, reader, quickMs: elapsed[0], fullMs: elapsed[0] + elapsed[1],
        quickFingerprint: resultFingerprint(quick), fullFingerprint: fingerprint(fullPayload(quick, thorough)),
        quickDiagnostics: quick.diagnostics, thoroughDiagnostics: thorough.diagnostics,
        processRssBytes: process.memoryUsage().rss });
    }
    const old = outcomes.get("baseline")!, next = outcomes.get("prepared")!;
    comparisons++;
    if (resultFingerprint(old.quick) !== resultFingerprint(next.quick)
      || resultFingerprint(old.thorough) !== resultFingerprint(next.thorough)
      || fingerprint(fullPayload(old.quick, old.thorough)) !== fingerprint(fullPayload(next.quick, next.thorough))) mismatches++;
  }
  await writeFile(outputPath, JSON.stringify({ comparisons, mismatches, budgets: CLOSED_ROUTE_EFFORT_BUDGETS,
    preparedConnections: prepared.connectionStats, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    limitations: ["Same-graph preconditions passed for all selected starts and both effort budgets.",
      "Full means the production union of per-start Quick and Thorough results.",
      "This comparison does not establish source completeness, migration coverage, or per-reader peak memory.",
      "RSS covers both readers in one process; measure total build/install memory separately in a constrained container."], rows }, null, 2));
  if (mismatches) throw new Error(`${mismatches}/${comparisons} comparisons differ; inspect ${outputPath}`);
  console.log(`${comparisons} Quick/Full comparisons match; report ${outputPath}`);
} finally { await baseline.close(); await prepared.close(); }
