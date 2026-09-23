import path from "node:path";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const OLYMPIC_PENINSULA_REGION_ROOT = path.resolve("data/regions/olympic-peninsula");

export const OLYMPIC_PENINSULA_PACK_CONFIG: RegionalPackDefinition = {
  id: "olympic-peninsula",
  name: "Olympic Peninsula",
  dataVersionPrefix: "op",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "olympic-peninsula-boundary-v1",
  regionRoot: OLYMPIC_PENINSULA_REGION_ROOT,
  display: { center: [-123.75, 47.8], zoom: 7.2 },
};

export const buildOlympicPeninsulaPack = createRegionalPackBuilder(OLYMPIC_PENINSULA_PACK_CONFIG);
