import { z } from "zod";
import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "../adapters";
import { readValidatedSnapshot } from "../file-source";

export const EAST_BAY_CURRENT_CLOSURES_SOURCE_ID = "ebrpd-current-trail-closures-2026-08-06";
export const EAST_BAY_CURRENT_CLOSURES_AUTHORITY = "East Bay Regional Park District";
export const EAST_BAY_CURRENT_CLOSURES_DATASET = "Human-reviewed current trail closures";
export const EAST_BAY_CURRENT_CLOSURES_VERSION = "reviewed-2026-08-06";
export const EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT = "2026-08-07T00:00:00Z";
export const EAST_BAY_CURRENT_CLOSURES_SOURCE_URL = "https://www.ebparks.org/alerts-closures";
export const EAST_BAY_CURRENT_CLOSURES_PAGE_HASH = "sha256:7da0a19c3982406e9171ad802c0d697e491f0d79bd79e90241b30a32a771c83b";
export const EAST_BAY_CURRENT_CLOSURES_PAGE_BYTES = 181_487;

const targetExternalIdSchema = z.string().regex(/^way\/[1-9]\d*$/, "Closure target must be an OSM way ID");
const coordinatesSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const closureSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal(EAST_BAY_CURRENT_CLOSURES_AUTHORITY),
  dataset: z.literal(EAST_BAY_CURRENT_CLOSURES_DATASET),
  reviewedAt: z.literal(EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT),
  sourcePage: z.object({
    url: z.literal(EAST_BAY_CURRENT_CLOSURES_SOURCE_URL),
    contentHash: z.literal(EAST_BAY_CURRENT_CLOSURES_PAGE_HASH),
    byteLength: z.literal(EAST_BAY_CURRENT_CLOSURES_PAGE_BYTES),
  }).strict(),
  records: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    park: z.string().trim().min(1),
    status: z.literal("closed"),
    firstPublishedOn: z.string().date(),
    updatedOn: z.string().date(),
    coordinates: coordinatesSchema,
    targetExternalIds: z.array(targetExternalIdSchema).min(1),
  }).strict()).min(1),
}).strict();

type ClosureSnapshot = z.infer<typeof closureSnapshotSchema>;

function assertUniqueRecords(input: ClosureSnapshot): void {
  const recordIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const record of input.records) {
    if (recordIds.has(record.id)) throw new Error(`Current-closure snapshot contains duplicate record ID ${record.id}`);
    recordIds.add(record.id);
    if (record.updatedOn < record.firstPublishedOn) {
      throw new Error(`Current-closure record ${record.id} was updated before it was first published`);
    }
    for (const targetId of record.targetExternalIds) {
      if (targetIds.has(targetId)) throw new Error(`Current-closure snapshot contains duplicate target ${targetId}`);
      targetIds.add(targetId);
    }
  }
}

export class EastBayCurrentClosuresAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "ebrpd-current-closures-v1";

  private async read(snapshot: SourceSnapshot): Promise<ClosureSnapshot> {
    if (
      snapshot.id !== EAST_BAY_CURRENT_CLOSURES_SOURCE_ID
      || snapshot.authority !== EAST_BAY_CURRENT_CLOSURES_AUTHORITY
      || snapshot.dataset !== EAST_BAY_CURRENT_CLOSURES_DATASET
      || snapshot.version !== EAST_BAY_CURRENT_CLOSURES_VERSION
      || snapshot.retrievedAt !== EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT
    ) {
      throw new Error("Source identity does not match the pinned EBRPD current-closure review");
    }
    if (snapshot.url !== EAST_BAY_CURRENT_CLOSURES_SOURCE_URL) {
      throw new Error(`Source URL does not match the pinned EBRPD alerts page for ${snapshot.id}`);
    }
    const input = closureSnapshotSchema.parse(await readValidatedSnapshot(snapshot));
    assertUniqueRecords(input);
    return input;
  }

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await this.read(snapshot);
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    const input = await this.read(snapshot);
    return input.records.flatMap((record) => record.targetExternalIds.map((targetExternalId) => ({
      sourceId: snapshot.id,
      externalId: targetExternalId,
      lon: record.coordinates[0],
      lat: record.coordinates[1],
      name: record.name,
      accessState: "closed" as const,
      confidence: "high" as const,
    }))).sort((first, second) => first.externalId.localeCompare(second.externalId));
  }
}
