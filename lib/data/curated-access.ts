import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SourceSnapshot } from "./adapters";
import type { NormalizedTopology, NormalizedWay } from "./types";

export const CURATED_ACCESS_SCHEMA_VERSION = 1;

const contentHashSchema = z.custom<`sha256:${string}`>(
  (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
  "Expected a lowercase SHA-256 content hash",
);
const externalWayIdSchema = z.string().regex(
  /^way\/[1-9]\d*$/,
  "Curated access targets must be canonical OSM way IDs",
);
const restrictiveAccessStateSchema = z.enum(["closed", "prohibited", "private"]);

const sourceMetadataSchema = z.object({
  id: z.string().trim().min(1),
  authority: z.string().trim().min(1),
  dataset: z.string().trim().min(1),
  version: z.string().trim().min(1),
  retrievedAt: z.string().datetime({ offset: true }),
  url: z.string().url(),
  license: z.string().trim().min(1),
}).strict();

const curatedAccessRestrictionSchema = z.object({
  externalId: externalWayIdSchema,
  accessState: restrictiveAccessStateSchema,
  reason: z.string().trim().min(1),
  review: z.object({
    reviewedAt: z.string().datetime({ offset: true }),
    reviewer: z.string().trim().min(1),
  }).strict(),
}).strict();

const curatedAccessFileSchema = z.object({
  schemaVersion: z.literal(CURATED_ACCESS_SCHEMA_VERSION),
  source: sourceMetadataSchema,
  restrictions: z.array(curatedAccessRestrictionSchema).min(1),
}).strict();

export type CuratedAccessRestriction = z.infer<typeof curatedAccessRestrictionSchema>;

export type CuratedAccessFile = {
  snapshot: SourceSnapshot;
  restrictions: CuratedAccessRestriction[];
};

function compareExternalWayIds(first: string, second: string): number {
  const firstDigits = first.slice("way/".length);
  const secondDigits = second.slice("way/".length);
  return firstDigits.length - secondDigits.length
    || (firstDigits < secondDigits ? -1 : firstDigits > secondDigits ? 1 : 0);
}

function normalizeRestrictions(input: readonly CuratedAccessRestriction[]): CuratedAccessRestriction[] {
  const seen = new Set<string>();
  for (const restriction of input) {
    if (seen.has(restriction.externalId)) {
      throw new Error(`Curated access contains duplicate target ${restriction.externalId}`);
    }
    seen.add(restriction.externalId);
  }
  return [...input]
    .sort((first, second) => compareExternalWayIds(first.externalId, second.externalId))
    .map((restriction) => ({
      ...restriction,
      review: { ...restriction.review },
    }));
}

/**
 * Reads a self-describing committed restriction file without consulting its
 * authority or the network. The returned snapshot hash covers the exact bytes
 * read; callers may additionally pin an expected hash for tamper detection.
 */
export async function readCuratedAccessFile(
  localPath: string,
  expectedContentHash?: `sha256:${string}`,
): Promise<CuratedAccessFile> {
  if (!localPath.trim()) throw new Error("Curated access path must not be empty");
  if (expectedContentHash !== undefined) contentHashSchema.parse(expectedContentHash);

  const contents = await readFile(localPath);
  const contentHash = `sha256:${createHash("sha256").update(contents).digest("hex")}` as const;
  if (expectedContentHash !== undefined && contentHash !== expectedContentHash) {
    throw new Error(`Content hash mismatch for curated access file ${localPath}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Curated access file ${localPath} is not valid JSON`, { cause: error });
  }
  const input = curatedAccessFileSchema.parse(decoded);
  return {
    snapshot: {
      ...input.source,
      contentHash,
      localPath,
    },
    restrictions: normalizeRestrictions(input.restrictions),
  };
}

function validatedRestrictions(restrictions: readonly CuratedAccessRestriction[]): CuratedAccessRestriction[] {
  return normalizeRestrictions(z.array(curatedAccessRestrictionSchema).min(1).parse(restrictions));
}

function applyRestriction(
  way: NormalizedWay,
  restriction: CuratedAccessRestriction,
  sourceId: string,
): NormalizedWay {
  if (way.sourceRefs.includes(sourceId) && way.accessState !== restriction.accessState) {
    throw new Error(`Curated source ${sourceId} conflicts with existing state for ${way.externalId}`);
  }
  if (
    way.accessState !== "public"
    && way.accessState !== "unknown"
    && way.accessState !== restriction.accessState
  ) {
    throw new Error(
      `Curated access ${restriction.accessState} conflicts with existing ${way.accessState} state for ${way.externalId}`,
    );
  }
  return {
    ...way,
    accessState: restriction.accessState,
    sourceRefs: [...new Set([...way.sourceRefs, sourceId])].sort(),
  };
}

/**
 * Applies reviewed removals to exact OSM ways. Curated data can only replace a
 * public/unknown state with a restriction or corroborate the same restriction.
 */
export function applyCuratedAccessRestrictions(
  topology: NormalizedTopology,
  sourceId: string,
  restrictions: readonly CuratedAccessRestriction[],
): NormalizedTopology {
  if (!sourceId.trim()) throw new Error("Curated access source ID must not be empty");
  const orderedRestrictions = validatedRestrictions(restrictions);
  const restrictionByExternalId = new Map(
    orderedRestrictions.map((restriction) => [restriction.externalId, restriction]),
  );
  const targetCounts = new Map<string, number>();
  for (const way of topology.ways) {
    if (!restrictionByExternalId.has(way.externalId)) continue;
    targetCounts.set(way.externalId, (targetCounts.get(way.externalId) ?? 0) + 1);
  }
  for (const restriction of orderedRestrictions) {
    const targetCount = targetCounts.get(restriction.externalId) ?? 0;
    if (targetCount === 0) throw new Error(`Curated access target ${restriction.externalId} is missing from topology`);
    if (targetCount > 1) throw new Error(`Topology contains duplicate curated access target ${restriction.externalId}`);
  }

  const ways = topology.ways.map((way) => {
    const restriction = restrictionByExternalId.get(way.externalId);
    return restriction ? applyRestriction(way, restriction, sourceId) : way;
  });
  return { ...topology, ways };
}
