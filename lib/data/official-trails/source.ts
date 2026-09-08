import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import { downloadToSourceCache, writeJsonAtomically, type CachedSource, type CacheDownloadOptions } from "../source-cache";
import type { OfficialTrailConflationPolicy } from "./types";

export const officialTrailSourceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("usgs-national-digital-trails"),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  authority: z.string().min(1),
  dataset: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url(),
  expectedByteLength: z.number().int().positive(),
  expectedSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  license: z.string().min(1),
  attribution: z.string().min(1),
}).strict();

export type OfficialTrailSourceConfig = z.infer<typeof officialTrailSourceConfigSchema>;
export const officialTrailConflationPolicySchema = z.object({
  sampleStepM: z.number().positive(),
  representedDistanceM: z.number().positive(),
  internalConnectionDistanceM: z.number().positive(),
  maximumConnectionAngleDegrees: z.number().positive().max(90),
  endpointConnectionDistanceM: z.number().positive(),
  candidateConnectionDistanceM: z.number().positive(),
  maximumTransitionLengthM: z.number().positive(),
  duplicateDistanceM: z.number().positive(),
  duplicateCoverageRatio: z.number().positive().max(1),
  minimumGapLengthM: z.number().positive(),
}).strict();
type OfficialTrailPointer = { configVersion: string; cached: CachedSource };

export async function readOfficialTrailSourceConfig(configPath: string): Promise<OfficialTrailSourceConfig> {
  return officialTrailSourceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

export async function readOfficialTrailConflationPolicy(configPath: string): Promise<OfficialTrailConflationPolicy> {
  return officialTrailConflationPolicySchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

export function officialTrailPointerPath(cacheRoot: string, sourceId: string): string {
  return path.join(cacheRoot, sourceId, "pinned.json");
}

export async function readPinnedOfficialTrailSnapshot(
  cacheRoot: string,
  config: OfficialTrailSourceConfig,
): Promise<SourceSnapshot> {
  const pointer = JSON.parse(await readFile(officialTrailPointerPath(cacheRoot, config.id), "utf8")) as OfficialTrailPointer;
  if (pointer.configVersion !== config.version) throw new Error("Cached official trail snapshot does not match configured version");
  if (pointer.cached.receipt.sha256 !== config.expectedSha256) throw new Error("Cached official trail snapshot does not match configured hash");
  if (pointer.cached.receipt.byteLength !== config.expectedByteLength) throw new Error("Cached official trail snapshot does not match configured byte length");
  return {
    id: config.id,
    authority: config.authority,
    dataset: config.dataset,
    version: config.version,
    retrievedAt: pointer.cached.receipt.retrievedAt,
    url: config.url,
    license: config.license,
    contentHash: pointer.cached.receipt.sha256,
    localPath: pointer.cached.filePath,
  };
}

export async function refreshPinnedOfficialTrailSnapshot(
  cacheRoot: string,
  config: OfficialTrailSourceConfig,
  fetchImpl?: typeof fetch,
  onProgress?: CacheDownloadOptions["onProgress"],
): Promise<{ snapshot: SourceSnapshot; cached: CachedSource }> {
  const cached = await downloadToSourceCache({
    cacheRoot,
    sourceId: config.id,
    url: config.url,
    fileName: `${config.id}-${config.version}.geojson`,
    expectedSha256: config.expectedSha256 as `sha256:${string}`,
    expectedByteLength: config.expectedByteLength,
    onProgress,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await writeJsonAtomically(officialTrailPointerPath(cacheRoot, config.id), {
    configVersion: config.version,
    cached,
  });
  return { snapshot: await readPinnedOfficialTrailSnapshot(cacheRoot, config), cached };
}
