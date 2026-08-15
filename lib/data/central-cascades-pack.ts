import path from "node:path";
import { createBasicRegionalPackBuilder, type BasicRegionalPackConfig } from "./basic-regional-pack";

export const CENTRAL_CASCADES_REGION_ROOT = path.resolve("data/regions/central-cascades");

export const CENTRAL_CASCADES_PACK_CONFIG: BasicRegionalPackConfig = {
  id: "central-cascades",
  name: "Central Cascades",
  dataVersionPrefix: "cc",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "central-cascades-boundary-v1",
  regionRoot: CENTRAL_CASCADES_REGION_ROOT,
  display: { center: [-121.2, 47.75], zoom: 7.5 },
  officialTrails: {
    sourceConfigPath: path.join(CENTRAL_CASCADES_REGION_ROOT, "official-trail-source.json"),
    conflationPolicyPath: path.join(CENTRAL_CASCADES_REGION_ROOT, "official-trail-conflation.json"),
  },
};

export const buildCentralCascadesPack = createBasicRegionalPackBuilder(CENTRAL_CASCADES_PACK_CONFIG);
