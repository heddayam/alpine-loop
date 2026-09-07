import path from "node:path";
import {
  MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
  MontereyReviewedAccessAdapter,
  montereyReviewedAccessSnapshot,
} from "./authorities";
import type { NormalizedAccessEvidence } from "./adapters";
import { createRegionalPackBuilder } from "./regional-builder";
import type { RegionalPackDefinition } from "./regional-build-types";

export const MONTEREY_CARMEL_REGION_ROOT = path.resolve("data/regions/monterey-carmel");

/**
 * The committed reviewed file still records its original closure review for
 * provenance, but only entrance records participate in the portal overlay.
 * Exact way restrictions are exclusively sourced from access-restrictions.json.
 */
export function montereyReviewedEntranceEvidence(
  evidence: readonly NormalizedAccessEvidence[],
): NormalizedAccessEvidence[] {
  const entrances: NormalizedAccessEvidence[] = [];
  for (const item of evidence) {
    if (/^entrance\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.externalId)) {
      if (item.accessState !== "public" || item.confidence !== "medium") {
        throw new Error(`Reviewed entrance evidence ${item.externalId} must be public with medium confidence`);
      }
      entrances.push(item);
      continue;
    }
    if (/^way\/[1-9]\d*$/.test(item.externalId)) {
      if (item.accessState !== "closed" || item.confidence !== "high") {
        throw new Error(`Reviewed closure provenance ${item.externalId} must be closed with high confidence`);
      }
      continue;
    }
    throw new Error(`Reviewed access evidence has unsupported target ${item.externalId}`);
  }
  return entrances.sort((first, second) => first.externalId.localeCompare(second.externalId));
}

export const MONTEREY_CARMEL_PACK_CONFIG: RegionalPackDefinition = {
  id: "monterey-carmel",
  name: "Monterey–Carmel",
  dataVersionPrefix: "mc",
  compilerVersion: "monterey-carmel-pack-compiler-v2",
  boundaryVersion: "monterey-carmel-boundary-v1",
  regionRoot: MONTEREY_CARMEL_REGION_ROOT,
  display: { center: [-121.83, 36.52], zoom: 10.5 },
  restrictions: { contentHash: "sha256:b9e5faa29030c6c0ea7c86d1a5f675cd5ae2ca0d8d68928cbf98f80a4b67b2f1" },
  entrances: async () => {
    const snapshot = montereyReviewedAccessSnapshot(MONTEREY_CARMEL_REGION_ROOT);
    if (snapshot.id !== MONTEREY_REVIEWED_ACCESS_SOURCE_ID) {
      throw new Error(`Reviewed access snapshot has unexpected source ID ${snapshot.id}`);
    }
    const adapter = new MontereyReviewedAccessAdapter();
    await adapter.validate(snapshot);
    return { snapshot, adapterVersion: adapter.adapterVersion,
      evidence: montereyReviewedEntranceEvidence(await adapter.normalize(snapshot)) };
  },
};

export const buildMontereyCarmelPack = createRegionalPackBuilder(MONTEREY_CARMEL_PACK_CONFIG);
