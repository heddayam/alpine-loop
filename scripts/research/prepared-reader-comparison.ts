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
import { CLOSED_ROUTE_BUDGET, listEligibleAccessPointCandidates, ReachableGraphClosedRouteSolver, type RouteSearchResult } from "@/lib/solver";
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
    const reachable = { startNodeId: point.nodeId, startCoordinates: [point.lon, point.lat] as const,
      maximumDistanceMeters: criteria.distanceMiles.max * 1609.344,
      maximumDirectedEdges: CLOSED_ROUTE_BUDGET.maximumDirectedEdges,
      includeUncertainAccess: criteria.includeUncertainAccess, coverage: input.prepared.coverage };
    const old = await baseline.getReachableGraph(reachable), next = await prepared.getReachableGraph(reachable);
    if (old.truncated !== next.truncated || graphFingerprint(old.graph) !== graphFingerprint(next.graph)) {
      throw new Error(`Same-graph precondition failed: reachable graph/keys/metrics at ${point.id} differ`);
    }
  }
  const repetitions = Math.max(1, Math.min(20, input.repetitions ?? 3));
  const sessions: unknown[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const outcomes = new Map<string, Map<string, string>>();
    // Each reader session models one worker: prepare once, then search its starts.
    // Alternate session order to reduce warm-filesystem and JIT bias.
    const readers: Array<[string, GraphRepository]> = [["baseline", baseline], ["prepared", prepared]];
    if (repetition % 2) readers.reverse();
    for (const [reader, repository] of readers) {
      const solver = new ReachableGraphClosedRouteSolver({
        pack: { id: repository.packId, dataVersion: metadata.get("dataVersion") ?? "comparison", builtAt: metadata.get("builtAt")! },
        sourceFreshness: metadata.get("builtAt"), sourceConfidence: "high", fallbackSourceIds: ["comparison"],
      });
      // Freeze only the solver clock for identical state/candidate budgets.
      // Graph I/O keeps its real deadline and reports truncation honestly.
      const context = { repository, accessFilter: { predicates: [input.prepared.coverage], coverage: input.prepared.coverage }, now: () => 0 };
      const sessionStartedAt = performance.now();
      const session = await solver.prepare(criteria, context);
      const preparationMs = performance.now() - sessionStartedAt;
      const fingerprints = new Map<string, string>();
      let searchMs = 0;
      for (const point of selected) {
        const begin = performance.now();
        const result = await session.generate({ limit: 10, startAccessPointId: point.id }, CLOSED_ROUTE_BUDGET);
        const elapsedMs = performance.now() - begin;
        searchMs += elapsedMs;
        const resultHash = resultFingerprint(result);
        fingerprints.set(point.id, resultHash);
        rows.push({ repetition, start: point.id, reader, searchMs: elapsedMs,
          resultFingerprint: resultHash, diagnostics: result.diagnostics,
          processRssBytes: process.memoryUsage().rss });
      }
      sessions.push({ repetition, reader, starts: selected.length, preparationMs, searchMs,
        totalMs: performance.now() - sessionStartedAt });
      outcomes.set(reader, fingerprints);
    }
    for (const point of selected) {
      comparisons++;
      if (outcomes.get("baseline")!.get(point.id) !== outcomes.get("prepared")!.get(point.id)) mismatches++;
    }
  }
  await writeFile(outputPath, JSON.stringify({ comparisons, mismatches, budget: CLOSED_ROUTE_BUDGET,
    preparedConnections: prepared.connectionStats, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    limitations: ["Same-graph preconditions passed for all selected starts under the production search budget.",
      "Each session prepares one worker once. Total time includes preparation and every selected start; per-start rows exclude preparation.",
      "This comparison does not establish source completeness, migration coverage, or per-reader peak memory.",
      "RSS covers both readers in one process; measure total build/install memory separately in a constrained container."], sessions, rows }, null, 2));
  if (mismatches) throw new Error(`${mismatches}/${comparisons} comparisons differ; inspect ${outputPath}`);
  console.log(`${comparisons} Full comparisons match; report ${outputPath}`);
} finally { await baseline.close(); await prepared.close(); }
