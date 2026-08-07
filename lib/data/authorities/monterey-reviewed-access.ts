import path from "node:path";
import { z } from "zod";
import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "../adapters";
import { readValidatedSnapshot } from "../file-source";

export const MONTEREY_REVIEWED_ACCESS_SOURCE_ID = "monterey-carmel-reviewed-official-access-2026-08-07";
export const MONTEREY_REVIEWED_ACCESS_AUTHORITY = "Bureau of Land Management / Monterey Peninsula Regional Park District / California State Parks";
export const MONTEREY_REVIEWED_ACCESS_DATASET = "Human-reviewed Monterey-Carmel official access overlay";
export const MONTEREY_REVIEWED_ACCESS_VERSION = "reviewed-2026-08-07";
export const MONTEREY_REVIEWED_ACCESS_REVIEWED_AT = "2026-08-07T17:28:17Z";
export const MONTEREY_REVIEWED_ACCESS_SOURCE_URL = "https://www.blm.gov/sites/default/files/docs/2022-05/Fort_Ord_Trail_Map_2022_508.pdf";
export const MONTEREY_REVIEWED_ACCESS_CONTENT_HASH = "sha256:b8cbf834860a5249c743757de025304bb77a13673cf46bc578c1c35c34256466";
export const MONTEREY_REVIEWED_ACCESS_RELATIVE_PATH = "official-sources/reviewed-access.json";

const authoritySchema = z.enum([
  "Bureau of Land Management",
  "Monterey Peninsula Regional Park District",
  "California State Parks",
]);
const conditionSchema = z.enum([
  "day-use",
  "signed-trails-only",
  "permit-free",
  "permit-required",
  "designated-trails-only",
  "walk-bike-permit-free",
  "parking-permit-required",
  "hazard-closure",
]);
const coordinateSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const sourcePageSchema = z.object({
  authority: authoritySchema,
  url: z.string().url(),
  upstreamDate: z.string().min(1),
  retrievedAt: z.literal(MONTEREY_REVIEWED_ACCESS_REVIEWED_AT),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
  license: z.string().min(1),
  redistribution: z.enum(["allowed", "requires-review"]),
  transport: z.literal("tls-chain-unavailable-in-review-environment").optional(),
  metadata: z.object({
    url: z.string().url(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z.number().int().positive(),
  }).strict().optional(),
  reviewedFacts: z.array(z.string().min(1)).min(1),
}).strict();
const baseRecord = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  authority: authoritySchema,
  system: z.string().min(1),
  name: z.string().min(1),
  coordinates: coordinateSchema,
  conditions: z.array(conditionSchema).min(1),
  sourcePageIndex: z.number().int().nonnegative(),
};
const entranceSchema = z.object({
  kind: z.literal("entrance"),
  ...baseRecord,
  accessState: z.literal("public"),
}).strict();
const closureSchema = z.object({
  kind: z.literal("trail-closure"),
  ...baseRecord,
  accessState: z.literal("closed"),
  targetExternalIds: z.array(z.string().regex(/^way\/[1-9]\d*$/)).min(1),
}).strict();
const reviewedAccessSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal(MONTEREY_REVIEWED_ACCESS_AUTHORITY),
  dataset: z.literal(MONTEREY_REVIEWED_ACCESS_DATASET),
  reviewedAt: z.literal(MONTEREY_REVIEWED_ACCESS_REVIEWED_AT),
  sourcePages: z.array(sourcePageSchema).min(1),
  records: z.array(z.discriminatedUnion("kind", [entranceSchema, closureSchema])).min(1),
}).strict();

type ReviewedAccess = z.infer<typeof reviewedAccessSchema>;

const EXPECTED_PAGES = new Map<string, readonly [string, number]>([
  ["https://www.blm.gov/sites/default/files/docs/2022-05/Fort_Ord_Trail_Map_2022_508.pdf", ["sha256:ade19d28b803800d718869c1005c01dda3e6b2617972a18f5d5f77b7f1166854", 7_693_516]],
  ["https://www.mprpd.org/palo-corona-park-rules", ["sha256:2bdf92c8eefb62e101295fd1f4377ac795fe703270c3ece27563df0a8fb45b4a", 100_656]],
  ["https://www.mprpd.org/garland-ranch-regional-park", ["sha256:de62631f9f4b9b1a60c7cff02ea133b49d793ec846f8253e809777b6c091b679", 105_628]],
  ["https://www.mprpd.org/access-permits", ["sha256:a1f6f089ea4b73c3c4482e21caebff4db2a55e61c0e3bbcfe853203a290c3d76", 102_459]],
  ["https://www.parks.ca.gov/?page_id=571", ["sha256:fbbeb441cf309f6eccea6111e8a5e0b9fa406165d43a2d9d0e185008e39b44a5", 90_280]],
  ["https://www.parks.ca.gov/?page_id=579", ["sha256:ae4651ed53cfc17386bb803fbdcef9164667fd5c2b4ec7788400e6df233cd6e2", 83_533]],
  ["https://www.parks.ca.gov/pages/579/files/Garrapata.pdf", ["sha256:ff8a8257ea6bbac7ba31a9ed18d83d123e0276fcbb26439d3413c606372a61f5", 768_833]],
  ["https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recs_pts/MapServer/14/query?where=FET_NAME%20IN%20(%27Badger%20Hills%20Trailhead%27%2C%27Creekside%20Terrace%20Trailhead%27)&outFields=OBJECTID%2CFET_NAME%2CFET_TYPE%2CFET_SUBTYPE%2CADM_UNIT_CD%2CADMIN_ST%2CLAT%2CLONG%2CWEB_DISPLAY%2CUNIT_NAME&returnGeometry=true&outSR=4326&f=json", ["sha256:432166ec232fb0f7fbcd8b73f9ae0a979ad4e3cc011e7eb723d958400f51f955", 1_870]],
]);

function validateReview(input: ReviewedAccess): void {
  if (input.sourcePages.length !== EXPECTED_PAGES.size) throw new Error("Reviewed-access source-page inventory drifted");
  const pageUrls = new Set<string>();
  for (const page of input.sourcePages) {
    if (pageUrls.has(page.url)) throw new Error(`Duplicate reviewed source page ${page.url}`);
    pageUrls.add(page.url);
    const expected = EXPECTED_PAGES.get(page.url);
    if (!expected || page.contentHash !== expected[0] || page.byteLength !== expected[1]) {
      throw new Error(`Reviewed source page provenance drifted for ${page.url}`);
    }
    if (page.url.startsWith("https://gis.blm.gov/") && (
      page.metadata?.url !== "https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recs_pts/MapServer/14?f=pjson"
      || page.metadata.contentHash !== "sha256:b06b2a2213c1ff3418a2d00727cc240ddf5c06d660a7f8509dd8f86fab5d5568"
      || page.metadata.byteLength !== 56_176
    )) throw new Error("Reviewed BLM trailhead metadata provenance drifted");
  }
  const recordIds = new Set<string>();
  const targets = new Set<string>();
  for (const record of input.records) {
    if (recordIds.has(record.id)) throw new Error(`Duplicate reviewed access record ${record.id}`);
    recordIds.add(record.id);
    const page = input.sourcePages[record.sourcePageIndex];
    if (!page || page.authority !== record.authority) throw new Error(`Invalid source-page reference for ${record.id}`);
    if (record.kind === "entrance") {
      if (record.conditions.includes("hazard-closure")) throw new Error(`Entrance ${record.id} cannot carry a trail closure`);
      continue;
    }
    if (!record.conditions.includes("hazard-closure")) throw new Error(`Trail closure ${record.id} lacks its closure condition`);
    for (const target of record.targetExternalIds) {
      if (targets.has(target)) throw new Error(`Duplicate reviewed closure target ${target}`);
      targets.add(target);
    }
  }
}

export function montereyReviewedAccessSnapshot(
  regionRoot = path.resolve("data/regions/monterey-carmel"),
): SourceSnapshot {
  return {
    id: MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
    authority: MONTEREY_REVIEWED_ACCESS_AUTHORITY,
    dataset: MONTEREY_REVIEWED_ACCESS_DATASET,
    version: MONTEREY_REVIEWED_ACCESS_VERSION,
    retrievedAt: MONTEREY_REVIEWED_ACCESS_REVIEWED_AT,
    url: MONTEREY_REVIEWED_ACCESS_SOURCE_URL,
    license: "BLM U.S. Government work; MPRPD and California State Parks facts reviewed for local evaluation; normalized derivative redistribution requires review",
    contentHash: MONTEREY_REVIEWED_ACCESS_CONTENT_HASH,
    localPath: path.join(regionRoot, MONTEREY_REVIEWED_ACCESS_RELATIVE_PATH),
  };
}

export class MontereyReviewedAccessAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "monterey-reviewed-access-v1";

  private async read(snapshot: SourceSnapshot): Promise<ReviewedAccess> {
    if (
      snapshot.id !== MONTEREY_REVIEWED_ACCESS_SOURCE_ID
      || snapshot.authority !== MONTEREY_REVIEWED_ACCESS_AUTHORITY
      || snapshot.dataset !== MONTEREY_REVIEWED_ACCESS_DATASET
      || snapshot.version !== MONTEREY_REVIEWED_ACCESS_VERSION
      || snapshot.retrievedAt !== MONTEREY_REVIEWED_ACCESS_REVIEWED_AT
    ) throw new Error("Source identity does not match the pinned Monterey reviewed access overlay");
    if (snapshot.url !== MONTEREY_REVIEWED_ACCESS_SOURCE_URL) throw new Error("Source URL does not match the pinned Monterey review");
    const input = reviewedAccessSchema.parse(await readValidatedSnapshot(snapshot));
    validateReview(input);
    return input;
  }

  async validate(snapshot: SourceSnapshot): Promise<void> { await this.read(snapshot); }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    const input = await this.read(snapshot);
    return input.records.flatMap((record): NormalizedAccessEvidence[] => {
      const common = {
        sourceId: snapshot.id,
        lon: record.coordinates[0],
        lat: record.coordinates[1],
        name: record.name,
      };
      if (record.kind === "entrance") return [{
        ...common,
        externalId: `entrance/${record.id}`,
        accessState: "public",
        confidence: "medium",
      }];
      return record.targetExternalIds.map((externalId) => ({
        ...common,
        externalId,
        accessState: "closed" as const,
        confidence: "high" as const,
      }));
    }).sort((first, second) => first.externalId.localeCompare(second.externalId));
  }
}
