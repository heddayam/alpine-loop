import path from "node:path";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const SANTA_CRUZ_REGION_ROOT = path.resolve("data/regions/santa-cruz-mountains");
export const SANTA_CRUZ_CURATED_ACCESS_PATH = path.join(SANTA_CRUZ_REGION_ROOT, "access-restrictions.json");

export const SANTA_CRUZ_PACK_CONFIG: RegionalPackDefinition = {
  id: "santa-cruz-mountains",
  name: "Santa Cruz Mountains",
  dataVersionPrefix: "scm",
  compilerVersion: "santa-cruz-pack-compiler-v14-portals",
  regionRoot: SANTA_CRUZ_REGION_ROOT,
  display: { center: [-122.18, 37.319], zoom: 13.5 },
  fingerprintFormat: "joined-v1",
  restrictions: { contentHash: "sha256:b648fdd3fae2f51d33b72398657ec297ea6a0e69c2c8167161b6c54c26aee5ea" },
};

export const buildSantaCruzPack = createRegionalPackBuilder(SANTA_CRUZ_PACK_CONFIG);
