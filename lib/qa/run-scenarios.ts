import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packManifestV1Schema } from "@/lib/contracts";
import {
  FixtureGraphRepository,
  SQLiteGraphRepository,
  type FixtureGraphData,
  type GraphRepository,
} from "@/lib/graph";
import { runScenarioSuite, type ScenarioPackMetadata, type ScenarioSuite } from "./scenario-runner";

type Arguments = {
  suitePath: string;
  fixturePath?: string;
  databasePath?: string;
  manifestPath?: string;
};

function usage(): string {
  return [
    "Usage:",
    "  npx tsx lib/qa/run-scenarios.ts --suite <suite.json> --fixture <graph.json>",
    "  npx tsx lib/qa/run-scenarios.ts --suite <suite.json> --database <pack.sqlite> --manifest <manifest.json>",
    "",
    "The command reads only local files and writes a machine-readable JSON report to stdout.",
  ].join("\n");
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(usage());
    values.set(key, value);
  }
  const suitePath = values.get("--suite");
  const fixturePath = values.get("--fixture");
  const databasePath = values.get("--database");
  const manifestPath = values.get("--manifest");
  if (!suitePath || Boolean(fixturePath) === Boolean(databasePath) || Boolean(databasePath) !== Boolean(manifestPath)) {
    throw new Error(usage());
  }
  return { suitePath, ...(fixturePath ? { fixturePath } : {}), ...(databasePath ? { databasePath, manifestPath } : {}) };
}

async function jsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

export async function runScenarioCli(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  const suite = await jsonFile(args.suitePath) as ScenarioSuite;
  let pack: ScenarioPackMetadata = suite.pack;
  let repositoryFactory: () => GraphRepository | Promise<GraphRepository>;

  if (args.fixturePath) {
    const fixture = await jsonFile(args.fixturePath) as FixtureGraphData;
    repositoryFactory = () => new FixtureGraphRepository(fixture);
  } else {
    const manifest = packManifestV1Schema.parse(await jsonFile(args.manifestPath!));
    pack = {
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      dataVersion: manifest.dataVersion,
      builtAt: manifest.builtAt,
    };
    repositoryFactory = () => new SQLiteGraphRepository(path.resolve(args.databasePath!), manifest.id);
  }

  const report = await runScenarioSuite({ suite: { ...suite, pack }, repositoryFactory });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runScenarioCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
