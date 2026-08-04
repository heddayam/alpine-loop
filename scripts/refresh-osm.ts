import path from "node:path";
import { readOsmSourceConfig, readPinnedOsmSnapshot, refreshPinnedOsmSnapshot } from "../lib/data/osm";
import { sha256File } from "../lib/data/file-source";

const HELP = `Usage: npx tsx scripts/refresh-osm.ts [--cache=<path>] [--validate|--offline]\n\nDownloads the committed, dated Geofabrik Northern California PBF only when run explicitly.\n--validate  Validate committed configuration without tools or network.\n--offline   Validate and report the already cached pinned snapshot without network.\n`;
const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);

if (process.argv.includes("--help")) {
  console.log(HELP);
} else {
  const configPath = path.resolve("data/regions/santa-cruz-mountains/osm-source.json");
  const config = await readOsmSourceConfig(configPath);
  if (process.argv.includes("--validate")) {
    console.log(JSON.stringify({ valid: true, id: config.id, version: config.version, url: config.url }, null, 2));
  } else {
    const cacheRoot = path.resolve(argument("--cache") ?? ".cache/sources");
    const result = process.argv.includes("--offline")
      ? { snapshot: await readPinnedOsmSnapshot(cacheRoot, config), cached: null }
      : await refreshPinnedOsmSnapshot(cacheRoot, config);
    const actualHash = await sha256File(result.snapshot.localPath);
    if (actualHash !== result.snapshot.contentHash) throw new Error("Cached OSM snapshot hash validation failed");
    console.log(JSON.stringify({
      id: result.snapshot.id,
      version: result.snapshot.version,
      localPath: result.snapshot.localPath,
      sha256: result.snapshot.contentHash,
      reused: result.cached?.reused ?? true,
    }, null, 2));
  }
}
