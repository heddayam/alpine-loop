import path from "node:path";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const HENRY_COE_REGION_ROOT = path.resolve("data/regions/henry-coe");

export const HENRY_COE_PACK_CONFIG: RegionalPackDefinition = {
  id: "henry-coe",
  name: "Henry Coe",
  dataVersionPrefix: "hc",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "henry-coe-boundary-v1",
  regionRoot: HENRY_COE_REGION_ROOT,
  display: { center: [-121.45, 37.17], zoom: 10.5 },
};

export const buildHenryCoePack = createRegionalPackBuilder(HENRY_COE_PACK_CONFIG);
