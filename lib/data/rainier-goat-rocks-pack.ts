import path from "node:path";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const RAINIER_GOAT_ROCKS_REGION_ROOT = path.resolve("data/regions/rainier-goat-rocks");

export const RAINIER_GOAT_ROCKS_PACK_CONFIG: RegionalPackDefinition = {
  id: "rainier-goat-rocks",
  name: "Rainier–Goat Rocks",
  dataVersionPrefix: "rgr",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "rainier-goat-rocks-boundary-v1",
  regionRoot: RAINIER_GOAT_ROCKS_REGION_ROOT,
  display: { center: [-121.54, 46.74], zoom: 8 },
};

export const buildRainierGoatRocksPack = createRegionalPackBuilder(RAINIER_GOAT_ROCKS_PACK_CONFIG);
