import path from "node:path";
import {
  readOfficialSourceConfigs,
  readOfficialSourceSnapshots,
  refreshOfficialSourceSnapshots,
} from "../lib/data/authorities";

const HELP = `Usage: npx tsx scripts/refresh-official-access.ts [--cache=<path>] [--validate|--offline]\n\nDownloads the pinned Midpen and Santa Clara County official access snapshots only when run explicitly.\nThe resulting data is approved for local evaluation only and must not be redistributed without review.\n`;
const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);

if (process.argv.includes("--help")) {
  console.log(HELP);
} else {
  const configs = await readOfficialSourceConfigs();
  if (process.argv.includes("--validate")) {
    console.log(JSON.stringify({ valid: true, sources: configs.map(({ id, version, redistribution }) => ({ id, version, redistribution })) }, null, 2));
  } else {
    const cacheRoot = path.resolve(argument("--cache") ?? ".cache/sources");
    const snapshots = process.argv.includes("--offline")
      ? await readOfficialSourceSnapshots(cacheRoot, configs)
      : await refreshOfficialSourceSnapshots(cacheRoot, configs);
    console.log(JSON.stringify({
      localEvaluationOnly: true,
      sources: snapshots.map(({ id, version, contentHash, localPath }) => ({ id, version, contentHash, localPath })),
    }, null, 2));
  }
}
