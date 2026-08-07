import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCuratedAccessRestrictions,
  readCuratedAccessFile,
  type CuratedAccessRestriction,
} from "./curated-access";
import type { NormalizedTopology, NormalizedWay } from "./types";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(
  temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
));

function reviewFile(restrictions: unknown = [
  restriction("way/10", "closed", "Seasonal habitat closure"),
  restriction("way/2", "private", "No public easement"),
  restriction("way/7", "prohibited", "Hiking is prohibited"),
]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: {
      id: "example-reviewed-access-2026-08-07",
      authority: "Example Parks",
      dataset: "Reviewed OSM way restrictions",
      version: "reviewed-2026-08-07",
      retrievedAt: "2026-08-07T18:00:00Z",
      url: "https://example.test/access",
      license: "Facts reviewed for local use",
    },
    restrictions,
  };
}

function restriction(
  externalId: string,
  accessState: "closed" | "prohibited" | "private" = "closed",
  reason = "Reviewed closure",
): CuratedAccessRestriction {
  return {
    externalId,
    accessState,
    reason,
    review: {
      reviewedAt: "2026-08-07T17:30:00Z",
      reviewer: "Example Parks GIS review",
    },
  };
}

async function sourceFor(input: unknown): Promise<{ localPath: string; hash: `sha256:${string}` }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curated-access-"));
  temporaryDirectories.push(directory);
  const localPath = path.join(directory, "restrictions.json");
  const contents = `${JSON.stringify(input, null, 2)}\n`;
  await writeFile(localPath, contents);
  return {
    localPath,
    hash: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
  };
}

function way(externalId: string, accessState: NormalizedWay["accessState"] = "unknown"): NormalizedWay {
  const number = externalId.slice("way/".length);
  return {
    id: `osm-way-${number}`,
    externalId,
    nodeIds: ["a", "b"],
    coordinates: [[-122, 37], [-121.99, 37.01]],
    name: `Way ${number}`,
    accessState,
    bidirectional: true,
    edgeClass: "trail",
    sourceRefs: ["osm"],
    flags: [],
  };
}

function topology(ways: NormalizedWay[]): NormalizedTopology {
  return {
    nodes: [],
    ways,
    accessPoints: [],
    rejectedWayCount: 0,
  };
}

describe("curated access files", () => {
  it("accepts all and only restrictive states and normalizes records by numeric OSM way ID", async () => {
    const source = await sourceFor(reviewFile());
    const result = await readCuratedAccessFile(source.localPath);
    expect(result.restrictions.map(({ externalId, accessState }) => [externalId, accessState])).toEqual([
      ["way/2", "private"],
      ["way/7", "prohibited"],
      ["way/10", "closed"],
    ]);
  });

  it("computes the exact file hash, constructs its source snapshot, and verifies a pinned hash", async () => {
    const source = await sourceFor(reviewFile());
    const result = await readCuratedAccessFile(source.localPath, source.hash);
    expect(result.snapshot).toEqual({
      id: "example-reviewed-access-2026-08-07",
      authority: "Example Parks",
      dataset: "Reviewed OSM way restrictions",
      version: "reviewed-2026-08-07",
      retrievedAt: "2026-08-07T18:00:00Z",
      url: "https://example.test/access",
      license: "Facts reviewed for local use",
      contentHash: source.hash,
      localPath: source.localPath,
    });
    await expect(readCuratedAccessFile(source.localPath, `sha256:${"0".repeat(64)}`)).rejects.toThrow(/hash mismatch/i);
  });

  it("applies restrictions only to exact external way IDs and adds a sorted source reference", () => {
    const original = topology([way("way/2", "public"), way("way/20"), way("way/7")]);
    const result = applyCuratedAccessRestrictions(original, "curated", [
      restriction("way/7", "prohibited"),
      restriction("way/2", "private"),
    ]);
    expect(result.ways.map(({ externalId, accessState, sourceRefs }) => ({ externalId, accessState, sourceRefs }))).toEqual([
      { externalId: "way/2", accessState: "private", sourceRefs: ["curated", "osm"] },
      { externalId: "way/20", accessState: "unknown", sourceRefs: ["osm"] },
      { externalId: "way/7", accessState: "prohibited", sourceRefs: ["curated", "osm"] },
    ]);
    expect(original.ways[0].accessState).toBe("public");
    expect(result.ways[1]).toBe(original.ways[1]);
  });

  it("rejects targets that are absent or ambiguous in the topology", () => {
    expect(() => applyCuratedAccessRestrictions(
      topology([way("way/1")]),
      "curated",
      [restriction("way/2")],
    )).toThrow(/missing from topology/);
    expect(() => applyCuratedAccessRestrictions(
      topology([way("way/2"), { ...way("way/2"), id: "duplicate" }]),
      "curated",
      [restriction("way/2")],
    )).toThrow(/duplicate curated access target/);
  });

  it("rejects duplicate file and applicator targets", async () => {
    const duplicate = [restriction("way/2"), restriction("way/2", "private")];
    const source = await sourceFor(reviewFile(duplicate));
    await expect(readCuratedAccessFile(source.localPath)).rejects.toThrow(/duplicate target way\/2/);
    expect(() => applyCuratedAccessRestrictions(topology([way("way/2")]), "curated", duplicate))
      .toThrow(/duplicate target way\/2/);
  });

  it.each(["public", "unknown"])("rejects the permissive %s state", async (accessState) => {
    const source = await sourceFor(reviewFile([{ ...restriction("way/2"), accessState }]));
    await expect(readCuratedAccessFile(source.localPath)).rejects.toThrow();
    expect(() => applyCuratedAccessRestrictions(
      topology([way("way/2")]),
      "curated",
      [{ ...restriction("way/2"), accessState } as unknown as CuratedAccessRestriction],
    )).toThrow();
  });

  it("rejects conflicting restrictions and is deterministic and idempotent for corroborating restrictions", () => {
    const input = topology([way("way/10"), way("way/2", "closed")]);
    const ordered = [restriction("way/2", "closed"), restriction("way/10", "private")];
    const reversed = [...ordered].reverse();
    const first = applyCuratedAccessRestrictions(input, "curated", ordered);
    const second = applyCuratedAccessRestrictions(input, "curated", reversed);
    expect(second).toEqual(first);
    expect(applyCuratedAccessRestrictions(first, "curated", reversed)).toEqual(first);
    expect(() => applyCuratedAccessRestrictions(
      topology([way("way/2", "private")]),
      "curated",
      [restriction("way/2", "closed")],
    )).toThrow(/conflicts with existing private/);
  });

  it("rejects non-canonical IDs and missing review metadata or reasons", async () => {
    for (const invalid of [
      restriction("way/02"),
      { ...restriction("way/2"), reason: "" },
      { ...restriction("way/2"), review: { reviewedAt: "2026-08-07", reviewer: "Reviewer" } },
    ]) {
      const source = await sourceFor(reviewFile([invalid]));
      await expect(readCuratedAccessFile(source.localPath)).rejects.toThrow();
    }
  });

  it("rejects unsupported schema versions and unrecognized fields", async () => {
    const wrongVersion = await sourceFor({ ...reviewFile(), schemaVersion: 2 });
    await expect(readCuratedAccessFile(wrongVersion.localPath)).rejects.toThrow();
    const extraField = await sourceFor({ ...reviewFile(), unreviewedNote: "not part of schema 1" });
    await expect(readCuratedAccessFile(extraField.localPath)).rejects.toThrow();
  });
});
