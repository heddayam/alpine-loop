import path from "node:path";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const SOUTHWEST_CASCADES_REGION_ROOT = path.resolve("data/regions/southwest-cascades");

export const SOUTHWEST_CASCADES_PACK_CONFIG: RegionalPackDefinition = {
  id: "southwest-cascades",
  name: "Southwest Cascades",
  dataVersionPrefix: "swc",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "southwest-cascades-boundary-v1",
  regionRoot: SOUTHWEST_CASCADES_REGION_ROOT,
  display: { center: [-121.95, 46.15], zoom: 8 },
};

export const buildSouthwestCascadesPack = createRegionalPackBuilder(SOUTHWEST_CASCADES_PACK_CONFIG);
