import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  inspectPinnedOsmSnapshot,
  OsmCacheVersionMismatchError,
  osmPointerPath,
  readPinnedOsmSnapshot,
  refreshPinnedOsmSnapshot,
  type OsmSourceConfig,
} from "./source";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const bytes = Buffer.from("tiny-offline-osm-fixture");
type FixturePointer = {
  configVersion: unknown;
  configUrl?: unknown;
  cached: { receipt: Record<string, unknown> };
};

async function fixture() {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "alpine-osm-version-"));
  roots.push(cacheRoot);
  const config: OsmSourceConfig = {
    schemaVersion: 1, id: "osm-fixture", authority: "Fixture", dataset: "OSM",
    version: "v1", upstreamTimestamp: "2026-01-01T00:00:00Z", url: "https://fixtures.invalid/v1.osm.pbf",
    expectedByteLength: bytes.length, license: "CC0", attribution: "Fixture",
  };
  const { snapshot } = await refreshPinnedOsmSnapshot(cacheRoot, config, async () => new Response(bytes));
  const pointerPath = osmPointerPath(cacheRoot, config.id);
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as FixturePointer;
  const requested = { ...config, version: "v2", url: "https://fixtures.invalid/v2.osm.pbf", expectedByteLength: bytes.length + 1 };
  return {
    cacheRoot, config, requested, snapshot, pointer,
    savePointer: () => writeFile(pointerPath, JSON.stringify(pointer)),
  };
}

async function strictFailure(operation: Promise<unknown>, message?: string) {
  const error = await operation.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(OsmCacheVersionMismatchError);
  if (message) expect((error as Error).message).toContain(message);
}

it("identifies a structurally valid same-source pin for another version", async () => {
  const { cacheRoot, requested } = await fixture();
  const error = await inspectPinnedOsmSnapshot(cacheRoot, requested).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(OsmCacheVersionMismatchError);
  expect(error).toMatchObject({ sourceId: "osm-fixture", cachedVersion: "v1", configuredVersion: "v2" });
  expect((error as Error).message).toContain("Cached OSM snapshot does not match configured version");
  expect((error as Error).message).toContain("osm-fixture: cached v1, configured v2");
  await expect(readPinnedOsmSnapshot(cacheRoot, requested)).rejects.toBeInstanceOf(OsmCacheVersionMismatchError);
});

const malformedPointers: [string, (pointer: FixturePointer) => void][] = [
  ["empty version", (pointer) => { pointer.configVersion = ""; }],
  ["non-string version", (pointer) => { pointer.configVersion = 2; }],
  ["invalid configured URL", (pointer) => { pointer.configUrl = "invalid"; }],
  ["missing receipt identity", (pointer) => { delete pointer.cached.receipt.sourceId; }],
  ["invalid receipt hash", (pointer) => { pointer.cached.receipt.sha256 = "sha256:invalid"; }],
  ["invalid receipt URL", (pointer) => { pointer.cached.receipt.originalUrl = "invalid"; }],
  ["invalid receipt date", (pointer) => { pointer.cached.receipt.retrievedAt = "invalid"; }],
  ["unexpected receipt property", (pointer) => { pointer.cached.receipt.extra = "invalid"; }],
];
it.each(malformedPointers)("rejects %s rather than classifying it as a stale pin", async (_name, mutate) => {
  const { cacheRoot, requested, pointer, savePointer } = await fixture();
  mutate(pointer);
  await savePointer();
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, requested));
});

it("rejects another source's receipt before classifying a version difference", async () => {
  const { cacheRoot, requested, pointer, savePointer } = await fixture();
  pointer.cached.receipt.sourceId = "different-source";
  await savePointer();
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, requested), "configured source");
});

it.each(["fileName", "sourceId"])("rejects a receipt %s path escape before classifying a version difference", async (field) => {
  const { cacheRoot, requested, pointer, savePointer } = await fixture();
  pointer.cached.receipt[field] = "../outside";
  await savePointer();
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, requested), "Unsafe cache path segment");
});

it("rejects an inconsistent cached file size before classifying a version difference", async () => {
  const { cacheRoot, requested, snapshot } = await fixture();
  await writeFile(snapshot.localPath, "short");
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, requested), "file size");
});

it("rejects a non-file source before classifying a version difference", async () => {
  const { cacheRoot, requested, snapshot } = await fixture();
  await rm(snapshot.localPath);
  await mkdir(snapshot.localPath);
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, requested), "file size");
});

it.each([
  { url: "https://fixtures.invalid/other.osm.pbf" },
  { expectedByteLength: bytes.length + 1 },
])("keeps matching-version source mismatches strict: %j", async (change) => {
  const { cacheRoot, config } = await fixture();
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, { ...config, ...change }), "configured source");
});

it("still verifies matching-version content rather than trusting receipt metadata", async () => {
  const { cacheRoot, config, snapshot } = await fixture();
  await writeFile(snapshot.localPath, Buffer.alloc(bytes.length, 120));
  expect(await inspectPinnedOsmSnapshot(cacheRoot, config)).toEqual(snapshot);
  await strictFailure(readPinnedOsmSnapshot(cacheRoot, config), "integrity");
});

it("accepts a configured URL repin without requiring receipt originalUrl equality", async () => {
  const { cacheRoot, config, pointer, savePointer, snapshot } = await fixture();
  const repinned = { ...config, url: "https://fixtures.invalid/repinned.osm.pbf" };
  pointer.configUrl = repinned.url;
  await savePointer();
  expect(await readPinnedOsmSnapshot(cacheRoot, repinned)).toEqual({ ...snapshot, url: repinned.url });
});
