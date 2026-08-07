import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import {
  EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
  EAST_BAY_CURRENT_CLOSURES_DATASET,
  EAST_BAY_CURRENT_CLOSURES_PAGE_BYTES,
  EAST_BAY_CURRENT_CLOSURES_PAGE_HASH,
  EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
  EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
  EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
  EAST_BAY_CURRENT_CLOSURES_VERSION,
  EastBayCurrentClosuresAdapter,
} from "./east-bay-closures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function currentClosureSnapshot() {
  return {
    schemaVersion: 1,
    authority: EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
    dataset: EAST_BAY_CURRENT_CLOSURES_DATASET,
    reviewedAt: EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
    sourcePage: {
      url: EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
      contentHash: EAST_BAY_CURRENT_CLOSURES_PAGE_HASH,
      byteLength: EAST_BAY_CURRENT_CLOSURES_PAGE_BYTES,
    },
    records: [{
      id: "ebrpd-shady-glen-trail-closure-2026-07-29",
      name: "Shady Glen Trail closure",
      park: "Sunol Regional Wilderness",
      status: "closed",
      firstPublishedOn: "2026-07-23",
      updatedOn: "2026-07-29",
      coordinates: [-121.831, 37.5175],
      targetExternalIds: ["way/284501999", "way/133590543", "way/284501998"],
    }],
  };
}

async function sourceFor(input: unknown): Promise<SourceSnapshot> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "east-bay-closures-"));
  temporaryDirectories.push(directory);
  const localPath = path.join(directory, "current-closures.json");
  await writeFile(localPath, JSON.stringify(input));
  return {
    id: EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
    authority: EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
    dataset: EAST_BAY_CURRENT_CLOSURES_DATASET,
    version: EAST_BAY_CURRENT_CLOSURES_VERSION,
    retrievedAt: EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
    url: EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
    license: "Human-reviewed facts for local evaluation; derivative redistribution requires review",
    contentHash: await sha256File(localPath),
    localPath,
  };
}

describe("East Bay current-closure adapter", () => {
  it("emits one deterministic high-confidence closure per pinned OSM way", async () => {
    const evidence = await new EastBayCurrentClosuresAdapter().normalize(await sourceFor(currentClosureSnapshot()));

    expect(evidence).toEqual([
      {
        sourceId: EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
        externalId: "way/133590543",
        lon: -121.831,
        lat: 37.5175,
        name: "Shady Glen Trail closure",
        accessState: "closed",
        confidence: "high",
      },
      {
        sourceId: EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
        externalId: "way/284501998",
        lon: -121.831,
        lat: 37.5175,
        name: "Shady Glen Trail closure",
        accessState: "closed",
        confidence: "high",
      },
      {
        sourceId: EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
        externalId: "way/284501999",
        lon: -121.831,
        lat: 37.5175,
        name: "Shady Glen Trail closure",
        accessState: "closed",
        confidence: "high",
      },
    ]);
  });

  it("fails closed on source identity, URL, and content-hash drift", async () => {
    const adapter = new EastBayCurrentClosuresAdapter();
    const source = await sourceFor(currentClosureSnapshot());
    await expect(adapter.validate({ ...source, id: "another-review" })).rejects.toThrow(/Source identity/);
    await expect(adapter.validate({ ...source, authority: "Another agency" })).rejects.toThrow(/Source identity/);
    await expect(adapter.validate({ ...source, dataset: "Another dataset" })).rejects.toThrow(/Source identity/);
    await expect(adapter.validate({ ...source, version: "reviewed-later" })).rejects.toThrow(/Source identity/);
    await expect(adapter.validate({ ...source, retrievedAt: "2026-08-08T00:00:00Z" })).rejects.toThrow(/Source identity/);
    await expect(adapter.validate({ ...source, url: `${source.url}?changed=true` })).rejects.toThrow(/pinned EBRPD alerts page/);
    await expect(adapter.validate({ ...source, contentHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow(/Content hash mismatch/);
  });

  it("rejects malformed provenance, status, target, geometry, and chronology", async () => {
    const adapter = new EastBayCurrentClosuresAdapter();

    const changedPageHash = currentClosureSnapshot();
    changedPageHash.sourcePage.contentHash = `sha256:${"0".repeat(64)}`;
    await expect(adapter.validate(await sourceFor(changedPageHash))).rejects.toThrow();

    const unsupportedStatus = currentClosureSnapshot();
    unsupportedStatus.records[0].status = "open";
    await expect(adapter.validate(await sourceFor(unsupportedStatus))).rejects.toThrow();

    const invalidTarget = currentClosureSnapshot();
    invalidTarget.records[0].targetExternalIds = ["node/133590543"];
    await expect(adapter.validate(await sourceFor(invalidTarget))).rejects.toThrow(/OSM way ID/);

    const invalidCoordinate = currentClosureSnapshot();
    invalidCoordinate.records[0].coordinates = [-181, 37.5175];
    await expect(adapter.validate(await sourceFor(invalidCoordinate))).rejects.toThrow();

    const invalidChronology = currentClosureSnapshot();
    invalidChronology.records[0].updatedOn = "2026-07-22";
    await expect(adapter.validate(await sourceFor(invalidChronology))).rejects.toThrow(/updated before/);
  });

  it("rejects duplicate record IDs and target OSM ways", async () => {
    const adapter = new EastBayCurrentClosuresAdapter();
    const duplicateRecord = currentClosureSnapshot();
    duplicateRecord.records.push({ ...duplicateRecord.records[0], targetExternalIds: ["way/1"] });
    await expect(adapter.validate(await sourceFor(duplicateRecord))).rejects.toThrow(/duplicate record ID/);

    const duplicateTarget = currentClosureSnapshot();
    duplicateTarget.records.push({
      ...duplicateTarget.records[0],
      id: "another-closure",
      targetExternalIds: ["way/133590543"],
    });
    await expect(adapter.validate(await sourceFor(duplicateTarget))).rejects.toThrow(/duplicate target way\/133590543/);
  });
});
