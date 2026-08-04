import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTrailSearchIndex } from "../scripts/trails/build-search-index.mjs";

const indexUrl = new URL("../app/trails/indexes/yosemite-stanislaus.json", import.meta.url);

test("the compact search index is deterministic and honors Gate C exceptions", async () => {
  const committed = JSON.parse(await readFile(indexUrl, "utf8"));
  const rebuilt = await buildTrailSearchIndex("yosemite-stanislaus");
  assert.deepEqual(rebuilt, committed);
  assert.equal(Object.keys(committed.trails).length, 282);
  assert.equal(
    committed.trails["named-trail_8fb704040434b8047e3edd34"].suppressed,
    true,
  );
  assert.equal(
    committed.trails["named-trail_67852acfa7dea387de91be6a"].routeClass,
    "advanced-climbing",
  );
  assert.match(
    committed.trails["named-trail_0fe1a07a5c313956682f89eb"].notices.join(" "),
    /seasonal winter use/i,
  );
  assert.equal("maxGradePct" in committed.trails["named-trail_67852acfa7dea387de91be6a"], false);
});

test("builds v2 search metadata from its declared two-character segment partitions", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "alpine-search-v2-index-"));
  const regionId = "v2-fixture";
  const directory = join(artifactRoot, regionId);
  await mkdir(join(directory, "segments"), { recursive: true });
  await mkdir(join(directory, "trail-geometry"), { recursive: true });
  const segment = {
    id: "segment_ab001",
    fromNodeId: "node-a",
    toNodeId: "node-b",
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    name: "V2 Trail",
    hiking: "allowed",
    access: "public",
    status: "open",
    lengthMeters: 100,
    sourceRefs: [],
  };
  try {
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      generatedAt: "2026-08-03T00:00:00.000Z",
      region: { id: regionId },
      artifacts: {
        "named-trails.json": { sha256: "1".repeat(64) },
        "segments/index.json": { sha256: "2".repeat(64) },
        "trail-geometry/index.json": { sha256: "3".repeat(64) },
      },
    }));
    await writeFile(join(directory, "named-trails.json"), JSON.stringify({
      schemaVersion: 1,
      regionId,
      trails: [{ id: "named-trail_ab", name: "V2 Trail", segmentIds: [segment.id] }],
    }));
    await writeFile(join(directory, "segments/index.json"), JSON.stringify({
      schemaVersion: 2,
      regionId,
      partitioning: { algorithm: "segment-id-hex-prefix", prefixLength: 2 },
      shards: { ab: { path: "segments/ab.ndjson", records: 1 } },
    }));
    await writeFile(join(directory, "segments/ab.ndjson"), `${JSON.stringify(segment)}\n`);
    await writeFile(join(directory, "trail-geometry/index.json"), JSON.stringify({
      schemaVersion: 2,
      regionId,
      objects: {
        "named-trail_ab": { path: "trail-geometry/ab/named-trail_ab.ndjson", records: 1 },
      },
    }));
    const index = await buildTrailSearchIndex(regionId, { artifactRoot });
    assert.equal(index.source.segmentPartitionPrefixLength, 2);
    assert.equal(index.source.trailGeometryIndexSha256, "3".repeat(64));
    assert.equal(index.trails["named-trail_ab"].hiking, "allowed");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
