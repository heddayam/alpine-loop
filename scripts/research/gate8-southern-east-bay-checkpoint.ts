import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  packManifestSchema,
  type GenerateClosedRoutesRequestV3,
  type PackManifestV5,
  type PackManifestV6,
  type SearchEffortV3,
} from "@/lib/contracts";
import { getSearchRegion } from "@/lib/data/named-area-catalog";
import {
  distanceMetersBetween,
  SQLiteClosedRouteFeasibilityRepository,
  SQLiteGraphRepository,
  type AccessPointCandidate,
} from "@/lib/graph";
import {
  CLOSED_ROUTE_EFFORT_BUDGETS,
  listEligibleAccessPointCandidates,
  ReachableGraphClosedRouteSolver,
  type ResolvedAccessFilterContext,
} from "@/lib/solver";

const PACK_ID = "southern-east-bay";
const DEFAULT_SCENARIOS_PATH = "data/regions/southern-east-bay/scenarios.json";
const ALL_REMOTENESS = ["remote", "rural", "populated", "unknown"] as const;

const expectationSchema = z.object({
  distanceMiles: z.object({ min: z.number().nonnegative(), max: z.number().positive() }).strict()
    .refine(({ min, max }) => min <= max, "Distance range must be ordered"),
  elevationGainFeet: z.object({ min: z.number().nonnegative(), max: z.number().positive() }).strict()
    .refine(({ min, max }) => min <= max, "Elevation range must be ordered"),
  result: z.enum(["at-least-one-exact", "near-miss-only"]),
}).strict();

const scenarioFileSchema = z.object({
  version: z.literal(1),
  packId: z.literal(PACK_ID),
  scenarios: z.array(z.object({
    id: z.string().min(1),
    cluster: z.string().min(1),
    referencePoint: z.object({
      name: z.string().min(1),
      coordinates: z.tuple([
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
      ]),
      synthetic: z.boolean().optional(),
    }).strict(),
    searchRegionId: z.string().min(1),
    candidateNamedAreaId: z.string().min(1).optional(),
    exactExpectation: expectationSchema.extend({ result: z.literal("at-least-one-exact") }).strict(),
    impossibleExpectation: expectationSchema.extend({ result: z.literal("near-miss-only") }).strict(),
  }).strict()).min(1),
}).strict();

type Scenario = z.infer<typeof scenarioFileSchema>["scenarios"][number];
type Expectation = Scenario["exactExpectation"] | Scenario["impossibleExpectation"];

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function usage(): string {
  return "Usage: node --import tsx scripts/research/gate8-southern-east-bay-checkpoint.ts "
    + "--database=<path> --manifest=<path> [--scenarios=<path>] [--effort=quick|thorough]";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nearestCandidate(
  candidates: readonly AccessPointCandidate[],
  coordinates: readonly [number, number],
): { candidate: AccessPointCandidate; distanceMeters: number } | undefined {
  return candidates
    .map((candidate) => ({
      candidate,
      distanceMeters: distanceMetersBetween(coordinates, [candidate.lon, candidate.lat]),
    }))
    .sort((left, right) => left.distanceMeters - right.distanceMeters
      || left.candidate.id.localeCompare(right.candidate.id))[0];
}

type CheckpointPackManifest = PackManifestV5 | PackManifestV6;

function buildRequest(
  manifest: CheckpointPackManifest,
  scenario: Scenario,
  startAccessPointId: string,
  expectation: Expectation,
  effort: SearchEffortV3,
): GenerateClosedRoutesRequestV3 {
  return {
    version: 3,
    packId: manifest.id,
    accessFilter: { mode: "named-region", regionId: scenario.searchRegionId },
    startAccessPointId,
    routeFamily: "closed",
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: expectation.distanceMiles,
    elevationGainFeet: expectation.elevationGainFeet,
    includeUncertainAccess: true,
    accessPointRemoteness: [...ALL_REMOTENESS],
    searchEffort: effort,
    limit: 10,
  };
}

async function runExpectation(options: {
  manifest: CheckpointPackManifest;
  scenario: Scenario;
  expectationName: "exact" | "impossible";
  expectation: Expectation;
  startAccessPointId: string;
  effort: SearchEffortV3;
  graphRepository: SQLiteGraphRepository;
  topologyRepository: SQLiteClosedRouteFeasibilityRepository;
  accessFilter: ResolvedAccessFilterContext;
}) {
  const validationRejections: Record<string, number> = {};
  const phaseTimings: Array<{ phase: string; elapsedMs: number }> = [];
  const { manifest } = options;
  const solver = new ReachableGraphClosedRouteSolver({
    pack: {
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      dataVersion: manifest.dataVersion,
      builtAt: manifest.builtAt,
    },
    sourceFreshness: manifest.sources.map(({ retrievedAt }) => retrievedAt).sort()[0] ?? manifest.builtAt,
    sourceConfidence: manifest.fieldConfidence.access ?? "low",
    fallbackSourceIds: manifest.sources.map(({ id }) => id),
    onValidationRejection: (reason) => {
      validationRejections[reason] = (validationRejections[reason] ?? 0) + 1;
    },
    onPhaseTiming: (phase, elapsedMs) => {
      phaseTimings.push({ phase, elapsedMs });
    },
  });
  const request = buildRequest(
    manifest,
    options.scenario,
    options.startAccessPointId,
    options.expectation,
    options.effort,
  );
  const startedAt = performance.now();
  const response = await solver.generate(request, {
    repository: options.graphRepository,
    topologyRepository: options.topologyRepository,
    budget: { ...CLOSED_ROUTE_EFFORT_BUDGETS[options.effort] },
    accessFilter: options.accessFilter,
  });
  const wallTimeMs = performance.now() - startedAt;
  const clearlyLabeledNearMisses = response.nearMisses.filter(({ violations }) => violations.length > 0);
  const passed = options.expectationName === "exact"
    ? response.exact.length >= 1
    : response.exact.length === 0 && clearlyLabeledNearMisses.length >= 1;
  return {
    expectation: options.expectationName,
    requestedConstraints: {
      distanceMiles: options.expectation.distanceMiles,
      elevationGainFeet: options.expectation.elevationGainFeet,
    },
    passed,
    wallTimeMs,
    exactCount: response.exact.length,
    nearMissCount: response.nearMisses.length,
    clearlyLabeledNearMissCount: clearlyLabeledNearMisses.length,
    nearMissViolations: response.nearMisses.map(({ id, violations }) => ({ id, violations })),
    diagnostics: response.diagnostics,
    validationRejections,
    phaseTimings,
  };
}

const databasePath = argument("--database");
const manifestPath = argument("--manifest");
const scenariosPath = argument("--scenarios") ?? DEFAULT_SCENARIOS_PATH;
if (!databasePath || !manifestPath) throw new Error(usage());

const effortArgument = argument("--effort") ?? "thorough";
if (effortArgument !== "quick" && effortArgument !== "thorough") {
  throw new Error(`--effort must be quick or thorough\n${usage()}`);
}
const effort: SearchEffortV3 = effortArgument;

const parsedManifest = packManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
if ((parsedManifest.schemaVersion !== "5" && parsedManifest.schemaVersion !== "6")
  || parsedManifest.id !== PACK_ID) {
  throw new Error(`Gate 8 requires the schema-5 or schema-6 ${PACK_ID} manifest`);
}
const manifest = parsedManifest;
const scenarioFile = scenarioFileSchema.parse(JSON.parse(await readFile(scenariosPath, "utf8")));
const graphRepository = new SQLiteGraphRepository(databasePath, manifest.id);
const runs: Array<Record<string, unknown>> = [];
const failures: string[] = [];
let topologyRepository: SQLiteClosedRouteFeasibilityRepository | undefined;

try {
  topologyRepository = new SQLiteClosedRouteFeasibilityRepository({ databasePath, manifest });
  for (const scenario of scenarioFile.scenarios) {
    try {
      const region = getSearchRegion(databasePath, scenario.searchRegionId);
      if (!region) throw new Error(`Reviewed search region ${scenario.searchRegionId} is missing from the pack`);
      const accessFilter: ResolvedAccessFilterContext = {
        summary: {
          mode: "named-region",
          label: region.name,
          region: { id: region.id, name: region.name },
        },
        predicates: [region.geometry],
        coverage: manifest.coverage.boundary,
      };
      const { eligible } = await listEligibleAccessPointCandidates({
        repository: graphRepository,
        accessFilter,
        includeUncertainAccess: true,
        accessPointRemoteness: ALL_REMOTENESS,
      });
      const selected = nearestCandidate(eligible, scenario.referencePoint.coordinates);
      if (!selected) throw new Error(`No eligible access point exists in ${scenario.searchRegionId}`);
      const exact = await runExpectation({
        manifest,
        scenario,
        expectationName: "exact",
        expectation: scenario.exactExpectation,
        startAccessPointId: selected.candidate.id,
        effort,
        graphRepository,
        topologyRepository,
        accessFilter,
      });
      const impossible = await runExpectation({
        manifest,
        scenario,
        expectationName: "impossible",
        expectation: scenario.impossibleExpectation,
        startAccessPointId: selected.candidate.id,
        effort,
        graphRepository,
        topologyRepository,
        accessFilter,
      });
      if (!exact.passed) failures.push(`${scenario.id}: exact expectation returned no exact route`);
      if (!impossible.passed) {
        failures.push(`${scenario.id}: impossible expectation did not return near-miss-only results`);
      }
      runs.push({
        scenario: {
          id: scenario.id,
          cluster: scenario.cluster,
          searchRegion: { id: region.id, name: region.name },
          ...(scenario.candidateNamedAreaId
            ? { candidateNamedAreaId: scenario.candidateNamedAreaId }
            : {}),
          referencePoint: scenario.referencePoint,
        },
        eligibleAccessPointCount: eligible.length,
        selectedAccessPoint: {
          id: selected.candidate.id,
          name: selected.candidate.name,
          lon: selected.candidate.lon,
          lat: selected.candidate.lat,
          distanceMeters: selected.distanceMeters,
          accessState: selected.candidate.accessState,
          confidence: selected.candidate.confidence,
          remotenessFields: {
            populationWithinRadius: selected.candidate.populationWithinRadius,
            localReliefM: selected.candidate.localReliefM,
          },
        },
        expectations: [exact, impossible],
      });
    } catch (error) {
      const message = `${scenario.id}: ${errorMessage(error)}`;
      failures.push(message);
      runs.push({ scenario: { id: scenario.id, cluster: scenario.cluster }, error: message });
    }
  }
} finally {
  if (topologyRepository) await topologyRepository.close();
  await graphRepository.close();
}

console.log(JSON.stringify({
  formatVersion: 1,
  checkpoint: "gate-8-southern-east-bay",
  passed: failures.length === 0,
  pack: {
    id: manifest.id,
    schemaVersion: manifest.schemaVersion,
    dataVersion: manifest.dataVersion,
    runtimeMode: manifest.closedRouteTopology.runtimeMode,
  },
  scenariosPath,
  effort,
  scenarioCount: scenarioFile.scenarios.length,
  failures,
  runs,
}, null, 2));

if (failures.length > 0) process.exitCode = 1;
