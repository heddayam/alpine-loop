import path from "node:path";
import {
  OsmPbfTopologyAdapter,
  readOsmSourceConfig,
  readPinnedOsmSnapshot,
  validateOsmPrerequisites,
} from "../lib/data/osm";
import {
  prepareThreeDepVrt,
  readElevationSourceConfig,
  readPinnedThreeDepCollection,
  validateGdalPrerequisites,
} from "../lib/data/elevation";

const HELP = `Usage: npx tsx scripts/prepare-santa-cruz-sources.ts [--cache=<path>] [--build-cache=<path>] [--validate]\n\nPrepares already refreshed, pinned OSM and 3DEP snapshots. This command never accesses the network.\nRun refresh-osm.ts and refresh-3dep.ts explicitly before it.\n--validate  Validate configuration and required local tools without reading cached sources.\n`;
const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);

if (process.argv.includes("--help")) {
  console.log(HELP);
} else {
  const cacheRoot = path.resolve(argument("--cache") ?? ".cache/sources");
  const buildCache = path.resolve(argument("--build-cache") ?? ".cache/build/santa-cruz-mountains/sources");
  const boundaryPath = path.resolve("data/regions/santa-cruz-mountains/boundary.geojson");
  const osmConfig = await readOsmSourceConfig(path.resolve("data/regions/santa-cruz-mountains/osm-source.json"));
  const elevationConfig = await readElevationSourceConfig(path.resolve("data/regions/santa-cruz-mountains/elevation-source.json"));
  const tools = { osmium: await validateOsmPrerequisites(), ...(await validateGdalPrerequisites()) };
  if (process.argv.includes("--validate")) {
    console.log(JSON.stringify({ valid: true, tools, osmVersion: osmConfig.version, demVersion: elevationConfig.version }, null, 2));
  } else {
    const osmSnapshot = await readPinnedOsmSnapshot(cacheRoot, osmConfig);
    const dem = await readPinnedThreeDepCollection(cacheRoot, elevationConfig);
    const topologyAdapter = new OsmPbfTopologyAdapter({
      boundaryPath,
      preparationRoot: path.join(buildCache, "osm"),
    });
    const topology = [];
    for await (const graph of topologyAdapter.normalize(osmSnapshot)) topology.push(graph);
    if (topology.length !== 1) throw new Error("OSM adapter did not produce exactly one topology graph");
    const vrtPath = await prepareThreeDepVrt(dem.collectionPath, path.join(buildCache, "elevation"));
    console.log(JSON.stringify({
      tools,
      osm: {
        snapshot: osmSnapshot.contentHash,
        nodes: topology[0].nodes.length,
        ways: topology[0].ways.length,
        accessPoints: topology[0].accessPoints.length,
        rejectedWays: topology[0].rejectedWayCount,
      },
      elevation: {
        snapshot: dem.snapshot.contentHash,
        products: dem.collection.products.length,
        vrtPath,
      },
    }, null, 2));
  }
}
