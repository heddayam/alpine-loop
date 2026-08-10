import registryInput from "@/data/regions/registry.json";
import { regionRegistryV1Schema } from "@/lib/contracts";
import { buildHenryCoePack } from "./henry-coe-pack";
import { buildMontereyCarmelPack } from "./monterey-carmel-pack";
import { buildSantaCruzPack } from "./santa-cruz-pack";
import { buildSouthernEastBayPack } from "./southern-east-bay-pack";
import type { PackBuildResult } from "./types";

export type RegionalPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
};

export type RegionalPackBuildResult = {
  pack: PackBuildResult;
  [key: string]: unknown;
};

export type RegionalPackBuilder = (options: RegionalPackBuildOptions) => Promise<RegionalPackBuildResult>;

const registry = regionRegistryV1Schema.parse(registryInput);
const builders = new Map<string, RegionalPackBuilder>([
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
