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

export const SANTA_CRUZ_OFFICIAL_CONFIGS = [
  "midpen.json",
  "santa-clara-county-parks.json",
] as const;

export type OfficialSourceSet = {
  configRoot: string;
  filenames: readonly string[];
  cacheNamespace: string;
};

export const SANTA_CRUZ_OFFICIAL_SOURCE_SET: OfficialSourceSet = {
  configRoot: path.resolve("data/regions/santa-cruz-mountains/official-sources"),
  filenames: SANTA_CRUZ_OFFICIAL_CONFIGS,
  cacheNamespace: "santa-cruz-official-access",
};

function validateSourceSet(sourceSet: OfficialSourceSet): OfficialSourceSet {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceSet.cacheNamespace)) {
    throw new Error(`Invalid official-source cache namespace: ${sourceSet.cacheNamespace}`);
  }
  for (const filename of sourceSet.filenames) {
    if (path.basename(filename) !== filename || !filename.endsWith(".json")) {
      throw new Error(`Invalid official-source config filename: ${filename}`);
    }
  }
  return sourceSet;
}

export async function readOfficialSourceConfigs(
  sourceSet: OfficialSourceSet = SANTA_CRUZ_OFFICIAL_SOURCE_SET,
): Promise<OfficialSourceConfig[]> {
  const validated = validateSourceSet(sourceSet);
  return Promise.all(validated.filenames.map(async (filename) =>
    sourceConfigSchema.parse(JSON.parse(await readFile(path.join(validated.configRoot, filename), "utf8")))));
}

function pointerPath(cacheRoot: string, sourceSet: OfficialSourceSet): string {
  return path.join(cacheRoot, validateSourceSet(sourceSet).cacheNamespace, "pinned.json");
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
  sourceSet: OfficialSourceSet = SANTA_CRUZ_OFFICIAL_SOURCE_SET,
): Promise<SourceSnapshot[]> {
  const configs = await readOfficialSourceConfigs(sourceSet);
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
  await writeJsonAtomically(pointerPath(cacheRoot, sourceSet), { schemaVersion: 1, sources: records } satisfies OfficialPointer);
  return snapshots;
}

export async function readOfficialSourceSnapshots(
  cacheRoot: string,
  sourceSet: OfficialSourceSet = SANTA_CRUZ_OFFICIAL_SOURCE_SET,
): Promise<SourceSnapshot[]> {
  const configs = await readOfficialSourceConfigs(sourceSet);
  const pointer = JSON.parse(await readFile(pointerPath(cacheRoot, sourceSet), "utf8")) as OfficialPointer;
  if (pointer.schemaVersion !== 1 || !Array.isArray(pointer.sources)) throw new Error("Invalid official-source pointer");
  return Promise.all(configs.map(async (config) => {
    const record = pointer.sources.find(({ id }) => id === config.id);
    if (!record || record.metadataContentHash !== config.metadataContentHash) {
      throw new Error(`Cached official source ${config.id} does not match the pinned metadata`);
    }
    return snapshot(config, record.localPath, await sha256File(record.localPath));
  }));
}
