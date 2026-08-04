import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import { downloadToSourceCache, writeJsonAtomically } from "../source-cache";

const sourceConfigSchema = z.object({
  id: z.string().min(1),
  authority: z.string().min(1),
  dataset: z.string().min(1),
  version: z.string().min(1),
  retrievedAt: z.string().datetime(),
  downloadUrl: z.string().url(),
  license: z.string().min(1),
  termsDecision: z.string().min(1),
  redistribution: z.enum(["allowed", "blocked", "requires-review"]),
  availability: z.string().optional(),
  metadataContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).passthrough();

export type OfficialSourceConfig = z.infer<typeof sourceConfigSchema>;
type PointerRecord = { id: string; metadataContentHash: string; localPath: string };
type OfficialPointer = { schemaVersion: 1; sources: PointerRecord[] };

export const FIRST_PACK_OFFICIAL_CONFIGS = [
  "midpen.json",
  "santa-clara-county-parks.json",
] as const;

export async function readOfficialSourceConfigs(
  configRoot = path.resolve("data/regions/santa-cruz-mountains/official-sources"),
): Promise<OfficialSourceConfig[]> {
  return Promise.all(FIRST_PACK_OFFICIAL_CONFIGS.map(async (filename) =>
    sourceConfigSchema.parse(JSON.parse(await readFile(path.join(configRoot, filename), "utf8")))));
}

function pointerPath(cacheRoot: string): string {
  return path.join(cacheRoot, "santa-cruz-official-access", "pinned.json");
}

function snapshot(config: OfficialSourceConfig, localPath: string, contentHash: `sha256:${string}`): SourceSnapshot {
  return {
    id: config.id,
    authority: config.authority,
    dataset: config.dataset,
    version: config.version,
    retrievedAt: config.retrievedAt,
    url: config.downloadUrl,
    license: `${config.license}; ${config.termsDecision}`,
    contentHash,
    localPath,
  };
}

export async function refreshOfficialSourceSnapshots(
  cacheRoot: string,
  suppliedConfigs?: OfficialSourceConfig[],
): Promise<SourceSnapshot[]> {
  const configs = suppliedConfigs ?? await readOfficialSourceConfigs();
  const records: PointerRecord[] = [];
  const snapshots: SourceSnapshot[] = [];
  for (const config of configs) {
    if (config.redistribution === "blocked" || config.availability?.startsWith("blocked")) {
      throw new Error(`Official source ${config.id} is not permitted or available for normalized ingestion`);
    }
    const cached = await downloadToSourceCache({
      cacheRoot,
      sourceId: config.id,
      url: config.downloadUrl,
      fileName: `${config.id}.json`,
      retrievedAt: config.retrievedAt,
    });
    records.push({ id: config.id, metadataContentHash: config.metadataContentHash, localPath: cached.filePath });
    snapshots.push(snapshot(config, cached.filePath, cached.receipt.sha256));
  }
  await writeJsonAtomically(pointerPath(cacheRoot), { schemaVersion: 1, sources: records } satisfies OfficialPointer);
  return snapshots;
}

export async function readOfficialSourceSnapshots(
  cacheRoot: string,
  suppliedConfigs?: OfficialSourceConfig[],
): Promise<SourceSnapshot[]> {
  const configs = suppliedConfigs ?? await readOfficialSourceConfigs();
  const pointer = JSON.parse(await readFile(pointerPath(cacheRoot), "utf8")) as OfficialPointer;
  if (pointer.schemaVersion !== 1 || !Array.isArray(pointer.sources)) throw new Error("Invalid official-source pointer");
  return Promise.all(configs.map(async (config) => {
    const record = pointer.sources.find(({ id }) => id === config.id);
    if (!record || record.metadataContentHash !== config.metadataContentHash) {
      throw new Error(`Cached official source ${config.id} does not match the pinned metadata`);
    }
    return snapshot(config, record.localPath, await sha256File(record.localPath));
  }));
}
