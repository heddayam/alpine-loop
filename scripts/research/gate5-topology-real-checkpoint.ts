import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { packManifestSchema, type GenerateClosedRoutesRequestV3 } from "@/lib/contracts";
import { SQLiteClosedRouteFeasibilityRepository, SQLiteGraphRepository } from "@/lib/graph";
import {
  CLOSED_ROUTE_EFFORT_BUDGETS,
  ReachableGraphClosedRouteSolver,
} from "@/lib/solver";

const DEFAULT_STARTS = [
  "osm-access-way-419983545",
  "osm-access-node-314138178",
  "osm-access-node-1423689504",
  "osm-access-node-9096651304",
  "osm-access-way-26662597",
];

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

const databasePath = argument("--database");
const manifestPath = argument("--manifest");
if (!databasePath || !manifestPath) {
  throw new Error("Usage: node --import tsx scripts/research/gate5-topology-real-checkpoint.ts --database=<path> --manifest=<path>");
}

const parsedManifest = packManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
if (parsedManifest.schemaVersion !== "3" && parsedManifest.schemaVersion !== "4" && parsedManifest.schemaVersion !== "5" && parsedManifest.schemaVersion !== "6") {
  throw new Error("The closed-route checkpoint requires a schema-3, schema-4, or schema-5 pack");
}
const manifest = parsedManifest;
const effortArgument = argument("--effort") ?? "thorough";
if (effortArgument !== "quick" && effortArgument !== "thorough") throw new Error("--effort must be quick or thorough");
const effort = effortArgument;
const starts = argument("--starts")?.split(",").filter(Boolean) ?? DEFAULT_STARTS;
const minimumDistanceMiles = Number(argument("--min-distance") ?? 6);
const maximumDistanceMiles = Number(argument("--max-distance") ?? 10);
const graphRepository = new SQLiteGraphRepository(databasePath, manifest.id);
const topologyRepository = new SQLiteClosedRouteFeasibilityRepository({ databasePath, manifest });
const validationRejections: Record<string, number> = {};
const phaseTimings: Array<{ phase: string; elapsedMs: number }> = [];
const solver = new ReachableGraphClosedRouteSolver({
  pack: { id: manifest.id, schemaVersion: manifest.schemaVersion, dataVersion: manifest.dataVersion, builtAt: manifest.builtAt },
  onValidationRejection: (reason) => { validationRejections[reason] = (validationRejections[reason] ?? 0) + 1; },
  onPhaseTiming: (phase, elapsedMs) => { phaseTimings.push({ phase, elapsedMs }); },
});
const runs = [];
try {
  for (const startAccessPointId of starts) {
    const request: GenerateClosedRoutesRequestV3 = {
      version: 3,
      packId: manifest.id,
      accessFilter: { mode: "drawn-area", bbox: manifest.coverage.bbox },
      startAccessPointId,
      routeFamily: "closed",
      closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
      distanceMiles: { min: minimumDistanceMiles, max: maximumDistanceMiles },
      ...(minimumDistanceMiles === 6 && maximumDistanceMiles === 10
        ? { elevationGainFeet: { min: 1_500, max: 2_500 } }
        : {}),
      includeUncertainAccess: true,
      accessPointRemoteness: ["remote", "rural", "populated", "unknown"],
      searchEffort: effort,
      limit: 10,
    };
    const startedAt = performance.now();
    const response = await solver.generate(request, {
      repository: graphRepository,
      topologyRepository,
      budget: { ...CLOSED_ROUTE_EFFORT_BUDGETS[effort] },
      accessFilter: {
        summary: { mode: "drawn-area", label: "Santa Cruz Mountains coverage" },
        predicates: [manifest.coverage.boundary],
        coverage: manifest.coverage.boundary,
      },
    });
    runs.push({
      startAccessPointId,
      wallTimeMs: performance.now() - startedAt,
      exactCount: response.exact.length,
      nearMissCount: response.nearMisses.length,
      diagnostics: response.diagnostics,
    });
  }
} finally {
  await graphRepository.close();
  await topologyRepository.close();
}

console.log(JSON.stringify({
  formatVersion: 1,
  pack: { id: manifest.id, schemaVersion: manifest.schemaVersion, dataVersion: manifest.dataVersion },
  effort,
  runs,
  runtimeMode: manifest.closedRouteTopology.runtimeMode,
  validationRejections,
  phaseTimings,
}, null, 2));
