import path from "node:path";
import {
  EastBayRegionalParkDistrictEntranceAdapter,
  readOfficialSourceSnapshots,
  refreshOfficialSourceSnapshots,
  type OfficialSourceSet,
} from "./authorities";
import { pointInArea, type AreaGeometry } from "./area-geometry";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";
import type { NormalizedTopology } from "./types";

export const SOUTHERN_EAST_BAY_REGION_ROOT = path.resolve("data/regions/southern-east-bay");

/** Entrance names only: refresh and offline reads never include EBRPD line data. */
export const SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET: OfficialSourceSet = {
  configRoot: path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "official-sources"),
  filenames: ["ebrpd-park-entrances.json"],
  cacheNamespace: "southern-east-bay-official-access",
};

function portalInventory(topology: NormalizedTopology, boundary: AreaGeometry) {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const corridor = { westernFoothills: 0, sunolOhlone: 0, delValle: 0 };
  for (const portal of topology.accessPoints) {
    const node = nodes.get(portal.nodeId);
    if (!node) throw new Error(`Portal ${portal.id} references missing node ${portal.nodeId}`);
    if (!pointInArea([node.lon, node.lat], boundary)) continue;
    if (node.lon <= -121.84) corridor.westernFoothills += 1;
    else if (node.lon <= -121.72) corridor.sunolOhlone += 1;
    else corridor.delValle += 1;
  }
  if (Object.values(corridor).some((count) => count === 0)) {
    throw new Error(`Portal inventory is not regionally useful: ${JSON.stringify(corridor)}`);
  }
  return { corridor };
}

export const SOUTHERN_EAST_BAY_PACK_CONFIG: RegionalPackDefinition = {
  id: "southern-east-bay",
  name: "Southern East Bay",
  dataVersionPrefix: "seb",
  compilerVersion: "southern-east-bay-pack-compiler-v3",
  boundaryVersion: "southern-east-bay-boundary-v1",
  regionRoot: SOUTHERN_EAST_BAY_REGION_ROOT,
  display: { center: [-121.82, 37.56], zoom: 10.5 },
  restrictions: { contentHash: "sha256:1401faa586587ad34bc49ab675be621709a2fab90a2c3a04418700c1caf27a88" },
  entrances: async (options) => {
    const snapshots = await (options.refresh ? refreshOfficialSourceSnapshots : readOfficialSourceSnapshots)(
      options.sourceCacheRoot, SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET,
    );
    const snapshot = snapshots.find(({ id }) => id === "ebrpd-park-entrances");
    if (!snapshot) throw new Error("Missing official snapshot ebrpd-park-entrances");
    const adapter = new EastBayRegionalParkDistrictEntranceAdapter();
    await adapter.validate(snapshot);
    return { snapshot, adapterVersion: adapter.adapterVersion, evidence: await adapter.normalize(snapshot) };
  },
  checkPortals: portalInventory,
};

export const buildSouthernEastBayPack = createRegionalPackBuilder(SOUTHERN_EAST_BAY_PACK_CONFIG);
