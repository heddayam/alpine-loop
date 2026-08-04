import path from "node:path";
import { compilePack, fixtureCompileOptions } from "../lib/data/index";

const packArgument = process.argv.find((argument) => argument.startsWith("--pack="));
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));

if (!packArgument) {
  console.error("Usage: npm run pack:bootstrap -- --pack=<pack-id>");
  process.exitCode = 2;
} else {
  const packId = packArgument.slice("--pack=".length);
  if (packId !== "fixture-pack") {
    console.error(`Pack ${packId} needs pinned real-source adapters from Gate 3. Gate 1 supports fixture-pack.`);
    process.exitCode = 1;
  } else {
    const outputRoot = path.resolve(outputArgument?.slice("--output=".length) ?? ".local-data/packs");
    const result = await compilePack(await fixtureCompileOptions(outputRoot));
    console.log(JSON.stringify({
      packDirectory: result.packDirectory,
      reusedExisting: result.reusedExisting,
      audit: result.audit,
    }, null, 2));
  }
}
