import registryInput from "@/data/regions/registry.json";
import { regionRegistryV1Schema } from "@/lib/contracts";
import { buildCentralCascadesPack } from "./central-cascades-pack";
import { buildHenryCoePack } from "./henry-coe-pack";
import { buildMontereyCarmelPack } from "./monterey-carmel-pack";
import { buildSantaCruzPack } from "./santa-cruz-pack";
import { buildSouthernEastBayPack } from "./southern-east-bay-pack";
import type { RegionalPackBuildOptions } from "./regional-build-types";
import type { createRegionalPackBuilder } from "./regional-builder";

export type { RegionalPackBuildOptions, RegionalPackBuildProgress } from "./regional-build-types";
export type RegionalPackBuilder = ReturnType<typeof createRegionalPackBuilder>;
export type RegionalPackBuildResult = Awaited<ReturnType<RegionalPackBuilder>>;

const registry = regionRegistryV1Schema.parse(registryInput);
const builders = new Map<string, RegionalPackBuilder>([
  ["central-cascades", buildCentralCascadesPack],
  ["henry-coe", buildHenryCoePack],
  ["monterey-carmel", buildMontereyCarmelPack],
  ["santa-cruz-mountains", buildSantaCruzPack],
  ["southern-east-bay", buildSouthernEastBayPack],
]);

export function listRegionalPackBuilderIds(): string[] {
  return [...builders.keys()].sort();
}

export function requireRegionalPackBuilder(packId: string): RegionalPackBuilder {
  const region = registry.regions.find((entry) => entry.id === packId || entry.packId === packId);
  if (!region) throw new Error(`Unknown regional pack '${packId}'`);
  const builder = builders.get(packId);
  if (!builder) throw new Error(`Region '${region.label}' is planned but does not have a pack builder yet`);
  return builder;
}

export async function buildRegionalPack(
  packId: string,
  options: RegionalPackBuildOptions,
): Promise<RegionalPackBuildResult> {
  return requireRegionalPackBuilder(packId)(options);
}
