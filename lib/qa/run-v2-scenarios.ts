import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packManifestV2Schema } from "@/lib/contracts";
import { getNamedArea } from "@/lib/data";
import { SQLiteGraphRepository, type AreaGeometry } from "@/lib/graph";
import type { ResolvedAccessFilterContext } from "@/lib/solver";
import { runV2ScenarioSuite, type V2ScenarioSuite } from "./v2-scenario-runner";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`Missing ${name}`);
  return path.resolve(value);
}

function drawnArea([west, south, east, north]: [number, number, number, number]): AreaGeometry {
  return { type: "Polygon", coordinates: [[
    [west, south], [east, south], [east, north], [west, north], [west, south],
  ]] };
}

export async function runV2ScenarioCli(): Promise<number> {
  const suitePath = argument("--suite");
  const databasePath = argument("--database");
  const manifestPath = argument("--manifest");
  const manifest = packManifestV2Schema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const raw = JSON.parse(await readFile(suitePath, "utf8")) as V2ScenarioSuite;
  const suite: V2ScenarioSuite = {
    ...raw,
    pack: {
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      dataVersion: manifest.dataVersion,
      builtAt: manifest.builtAt,
      coverage: manifest.coverage.boundary,
    },
  };
  const report = await runV2ScenarioSuite({
    suite,
    repositoryFactory: () => new SQLiteGraphRepository(databasePath, manifest.id),
    resolveFilter: async (request): Promise<ResolvedAccessFilterContext> => {
      if (request.accessFilter.mode === "drawn-area") {
        const geometry = drawnArea(request.accessFilter.bbox);
        return {
          summary: { mode: "drawn-area", label: "Drawn area" },
          predicates: [geometry],
          coverage: manifest.coverage.boundary,
        };
      }
      if (request.accessFilter.mode === "named-region") {
        const area = getNamedArea(databasePath, request.accessFilter.regionId);
        if (!area) throw new Error(`Missing named area ${request.accessFilter.regionId}`);
        return {
          summary: { mode: "named-region", label: area.name, region: { id: area.id, name: area.name } },
          predicates: [area.geometry],
          coverage: manifest.coverage.boundary,
        };
      }
      throw new Error("Real-pack CLI scenarios do not submit external reachability jobs");
    },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runV2ScenarioCli().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
