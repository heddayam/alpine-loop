import path from "node:path";
import { compilePack } from "../lib/data/compiler";
import { fixtureCompileOptions } from "../lib/data/fixture-pack";
import { buildRegionalPack, type RegionalPackBuildProgress } from "../lib/data/regional-pack";

export function formatRegionalPackBuildProgress(progress: RegionalPackBuildProgress): string {
  return `[${progress.phase}/${progress.phaseCount}] ${progress.label}`;
}

const packArgument = process.argv.find((argument) => argument.startsWith("--pack="));
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const cacheArgument = process.argv.find((argument) => argument.startsWith("--cache="));
const buildCacheArgument = process.argv.find((argument) => argument.startsWith("--build-cache="));
const progressEnabled = process.argv.includes("--progress");

if (!packArgument) {
  console.error("Usage: npm run pack:bootstrap -- --pack=<pack-id> [--progress]");
  process.exitCode = 2;
} else {
  const packId = packArgument.slice("--pack=".length);
  const outputRoot = path.resolve(outputArgument?.slice("--output=".length) ?? ".local-data/packs");
  if (packId !== "fixture-pack") {
    const result = await buildRegionalPack(packId, {
      outputRoot,
      sourceCacheRoot: path.resolve(cacheArgument?.slice("--cache=".length) ?? ".cache/sources"),
      preparationRoot: path.resolve(buildCacheArgument?.slice("--build-cache=".length) ?? `.cache/build/${packId}/sources`),
      refresh: !process.argv.includes("--offline"),
      ...(progressEnabled ? {
        onProgress: (progress: RegionalPackBuildProgress) => {
          process.stdout.write(`${formatRegionalPackBuildProgress(progress)}\n`);
        },
      } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await compilePack(await fixtureCompileOptions(outputRoot));
    console.log(JSON.stringify({
      packDirectory: result.packDirectory,
      reusedExisting: result.reusedExisting,
      audit: result.audit,
    }, null, 2));
  }
}
