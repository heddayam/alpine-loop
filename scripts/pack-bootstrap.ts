import path from "node:path";
import { compilePack } from "../lib/data/compiler";
import { fixtureCompileOptions } from "../lib/data/fixture-pack";
import { buildSantaCruzPack } from "../lib/data/santa-cruz-pack";

const packArgument = process.argv.find((argument) => argument.startsWith("--pack="));
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const cacheArgument = process.argv.find((argument) => argument.startsWith("--cache="));
const buildCacheArgument = process.argv.find((argument) => argument.startsWith("--build-cache="));

if (!packArgument) {
  console.error("Usage: npm run pack:bootstrap -- --pack=<pack-id>");
  process.exitCode = 2;
} else {
  const packId = packArgument.slice("--pack=".length);
  const outputRoot = path.resolve(outputArgument?.slice("--output=".length) ?? ".local-data/packs");
  if (packId === "santa-cruz-mountains") {
    const result = await buildSantaCruzPack({
      outputRoot,
      sourceCacheRoot: path.resolve(cacheArgument?.slice("--cache=".length) ?? ".cache/sources"),
      preparationRoot: path.resolve(buildCacheArgument?.slice("--build-cache=".length) ?? ".cache/build/santa-cruz-mountains/sources"),
      refresh: !process.argv.includes("--offline"),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (packId !== "fixture-pack") {
    console.error(`Unknown pack ${packId}`);
    process.exitCode = 1;
  } else {
    const result = await compilePack(await fixtureCompileOptions(outputRoot));
    console.log(JSON.stringify({
      packDirectory: result.packDirectory,
      reusedExisting: result.reusedExisting,
      audit: result.audit,
    }, null, 2));
  }
}
