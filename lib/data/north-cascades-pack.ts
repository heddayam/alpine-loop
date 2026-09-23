import path from "node:path";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const NORTH_CASCADES_REGION_ROOT = path.resolve("data/regions/north-cascades");

export const NORTH_CASCADES_PACK_CONFIG: RegionalPackDefinition = {
  id: "north-cascades",
  name: "North Cascades",
  dataVersionPrefix: "nc",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "north-cascades-boundary-v2",
  regionRoot: NORTH_CASCADES_REGION_ROOT,
  display: { center: [-121.0, 48.53], zoom: 7.5 },
};

export const buildNorthCascadesPack = createRegionalPackBuilder(NORTH_CASCADES_PACK_CONFIG);
