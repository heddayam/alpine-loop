import path from "node:path";
import { createBasicRegionalPackBuilder, type BasicRegionalPackConfig } from "./basic-regional-pack";

export const HENRY_COE_REGION_ROOT = path.resolve("data/regions/henry-coe");

export const HENRY_COE_PACK_CONFIG: BasicRegionalPackConfig = {
  id: "henry-coe",
  name: "Henry Coe",
  dataVersionPrefix: "hc",
  compilerVersion: "basic-regional-pack-compiler-v1",
  boundaryVersion: "henry-coe-boundary-v1",
  regionRoot: HENRY_COE_REGION_ROOT,
  display: { center: [-121.45, 37.17], zoom: 10.5 },
};

export const buildHenryCoePack = createBasicRegionalPackBuilder(HENRY_COE_PACK_CONFIG);
