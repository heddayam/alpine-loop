import path from "node:path";
import {
  readElevationSourceConfig,
  readPinnedThreeDepCollection,
  refreshPinnedThreeDepCollection,
} from "../lib/data/elevation";

const HELP = `Usage: npx tsx scripts/refresh-3dep.ts [--cache=<path>] [--validate|--offline]\n\nQueries and downloads USGS 3DEP 1/3 arc-second GeoTIFF products only when run explicitly.\n--validate  Validate committed configuration without tools or network.\n--offline   Validate and report the cached product collection without network.\n`;
const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);

if (process.argv.includes("--help")) {
  console.log(HELP);
} else {
  const configPath = path.resolve("data/regions/santa-cruz-mountains/elevation-source.json");
  const config = await readElevationSourceConfig(configPath);
  if (process.argv.includes("--validate")) {
    console.log(JSON.stringify({
      valid: true,
      id: config.id,
      catalogId: config.catalogId,
      resolution: config.resolution,
      verticalDatum: config.verticalDatum,
    }, null, 2));
  } else {
    const cacheRoot = path.resolve(argument("--cache") ?? ".cache/sources");
    const result = process.argv.includes("--offline")
      ? await readPinnedThreeDepCollection(cacheRoot, config)
      : await refreshPinnedThreeDepCollection(cacheRoot, config);
    console.log(JSON.stringify({
      id: result.snapshot.id,
      collectionPath: result.collectionPath,
      sha256: result.snapshot.contentHash,
      productCount: result.collection.products.length,
      products: result.collection.products.map(({ productId, receipt }) => ({ productId, sha256: receipt.sha256 })),
    }, null, 2));
  }
}
