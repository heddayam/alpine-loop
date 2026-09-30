import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "@/lib/data/adapters";
import {
  OsmCacheVersionMismatchError,
  readPinnedOsmSnapshot,
  refreshPinnedOsmSnapshot,
  type OsmSourceConfig,
} from "@/lib/data/osm/source";
import type { CachedSource } from "@/lib/data/source-cache";
import { rectangle } from "./geometry";
import { importLocalSources, preparationInputs, type preparationSession } from "./preparation";
import type { SourceRecipe } from "./recipe";
import { CoverageSourceStore } from "./source-store";

vi.mock("@/lib/data/osm/source", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/data/osm/source")>(),
  readPinnedOsmSnapshot: vi.fn(),
  refreshPinnedOsmSnapshot: vi.fn(),
}));
// Preparation-input checks must finish before a source store or native database opens.
vi.mock("./source-store", () => ({ CoverageSourceStore: vi.fn(), sourceStoreFileName: vi.fn() }));

const hash = `sha256:${"1".repeat(64)}` as const;
const config: OsmSourceConfig = Object.freeze({
  schemaVersion: 1,
  id: "fixture-osm",
  authority: "Fixture authority",
  dataset: "Fixture configured extract",
  version: "2026-09-01",
  upstreamTimestamp: "2026-09-01T00:00:00Z",
  url: "https://example.invalid/fixture-260901.osm.pbf",
  expectedByteLength: 32,
  license: "CC0-1.0",
  attribution: "Synthetic fixture",
});
const geometry = rectangle([-122.1, 47.1, -122, 47.2]);
type Session = Awaited<ReturnType<typeof preparationSession>>;
let root: string;
let session: Session;
let snapshot: SourceSnapshot;
let acquired: { snapshot: SourceSnapshot; cached: CachedSource };

function recipe(offline = false): SourceRecipe {
  return {
    schemaVersion: 1,
    sources: [{ config, geometry, sha256: hash }],
    exclusions: [],
    reviewedRegionIds: [],
    memoryLimitMiB: 512,
    offline,
    limitations: [],
  };
}
function missingPin() {
  return Object.assign(new Error("Fixture pinned.json is absent"), { code: "ENOENT" });
}
function stalePin() {
  return new OsmCacheVersionMismatchError(config.id, "2026-08-01", config.version);
}
function stages() {
  return vi.mocked(session.report).mock.calls.map(([stage]) => stage);
}
async function prepareAndImport(input = recipe()) {
  await importLocalSources(session, await preparationInputs(input, session, geometry), geometry);
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request in preparation fixture"); }));
  root = await mkdtemp(path.join(tmpdir(), "coverage-preparation-"));
  const cacheRoot = path.join(root, "source-cache");
  session = {
    root,
    cacheRoot,
    scratchRoot: path.join(root, "scratch"),
    outputRoot: path.join(root, "release"),
    raws: [],
    units: [],
    check: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  snapshot = {
    id: config.id,
    authority: config.authority,
    dataset: config.dataset,
    version: config.version,
    retrievedAt: "2026-09-29T00:00:00Z",
    url: config.url,
    license: config.license,
    contentHash: hash,
    localPath: path.join(cacheRoot, "fixture.osm.pbf"),
  };
  acquired = {
    snapshot,
    cached: {
      directory: cacheRoot,
      filePath: snapshot.localPath,
      receiptPath: path.join(cacheRoot, "receipt.json"),
      reused: false,
      receipt: {
        schemaVersion: 1,
        sourceId: config.id,
        originalUrl: config.url,
        resolvedUrl: config.url,
        retrievedAt: snapshot.retrievedAt,
        byteLength: config.expectedByteLength,
        sha256: hash,
        fileName: "fixture.osm.pbf",
      },
    },
  };
  vi.mocked(readPinnedOsmSnapshot).mockResolvedValue(snapshot);
  vi.mocked(refreshPinnedOsmSnapshot).mockResolvedValue(acquired);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("configured OSM inputs before preparation", () => {
  it("reuses a verified configured pin without acquiring it", async () => {
    await expect(preparationInputs(recipe(), session, geometry)).resolves.toEqual({ restrictions: [], snapshots: [snapshot] });
    expect(readPinnedOsmSnapshot).toHaveBeenCalledExactlyOnceWith(session.cacheRoot, config);
    expect(refreshPinnedOsmSnapshot).not.toHaveBeenCalled();
    expect(session.check).toHaveBeenCalledOnce();
    expect(stages()).toEqual([`Verifying ${config.dataset}`]);
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", missingPin],
    ["a previous configured version", stalePin],
  ])("acquires the requested pin when its cache is %s and online", async (_label, failure) => {
    vi.mocked(readPinnedOsmSnapshot).mockRejectedValue(failure());
    const input = recipe();
    await expect(preparationInputs(input, session, geometry)).resolves.toEqual({ restrictions: [], snapshots: [snapshot] });
    expect(refreshPinnedOsmSnapshot).toHaveBeenCalledExactlyOnceWith(session.cacheRoot, config);
    expect(input.sources[0]!.config).toEqual(config);
    expect(input.sources[0]!.config.version).toBe("2026-09-01");
    expect(stages()).toEqual([`Verifying ${config.dataset}`, `Acquiring ${config.dataset}`]);
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", missingPin],
    ["stale", stalePin],
  ])("rejects a %s pin in offline mode without acquiring anything", async (_label, failure) => {
    const error = failure();
    vi.mocked(readPinnedOsmSnapshot).mockRejectedValue(error);
    await expect(prepareAndImport(recipe(true))).rejects.toBe(error);
    expect(refreshPinnedOsmSnapshot).not.toHaveBeenCalled();
    expect(stages()).toEqual([`Verifying ${config.dataset}`]);
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed pointer", () => new SyntaxError("Unexpected token in pinned.json")],
    ["wrong source identity", () => new Error("Cached OSM snapshot does not match configured source")],
    ["same-size content corruption", () => new Error("Cached OSM source failed integrity validation")],
    ["wrong file size", () => new Error("Cached OSM source failed integrity validation (file size)")],
    ["unreadable pointer", () => Object.assign(new Error("Fixture pointer is unreadable"), { code: "EACCES" })],
    ["an untyped version-message error", () => new Error("Cached OSM snapshot does not match configured version")],
    ["an unrelated failure", () => new Error("Unexpected verification failure")],
    ["a null rejection", () => null],
    ["an undefined rejection", () => undefined],
  ])("preserves %s failure rather than treating it as an absent pin", async (_label, failure) => {
    const error = failure();
    vi.mocked(readPinnedOsmSnapshot).mockRejectedValue(error);
    await expect(prepareAndImport()).rejects.toBe(error);
    expect(refreshPinnedOsmSnapshot).not.toHaveBeenCalled();
    expect(stages()).toEqual([`Verifying ${config.dataset}`]);
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a verified cached snapshot with a different recipe hash before importing", async () => {
    vi.mocked(readPinnedOsmSnapshot).mockResolvedValue({ ...snapshot, contentHash: `sha256:${"2".repeat(64)}` });
    await expect(prepareAndImport()).rejects.toThrow(`Pinned source hash differs for ${config.id}`);
    expect(refreshPinnedOsmSnapshot).not.toHaveBeenCalled();
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(stages()).toEqual([`Verifying ${config.dataset}`]);
  });

  it("rejects newly acquired bytes with a different recipe hash before importing", async () => {
    vi.mocked(readPinnedOsmSnapshot).mockRejectedValue(stalePin());
    vi.mocked(refreshPinnedOsmSnapshot).mockResolvedValue({
      ...acquired,
      snapshot: { ...snapshot, contentHash: `sha256:${"2".repeat(64)}` },
    });
    await expect(prepareAndImport()).rejects.toThrow(`Pinned source hash differs for ${config.id}`);
    expect(refreshPinnedOsmSnapshot).toHaveBeenCalledExactlyOnceWith(session.cacheRoot, config);
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(stages()).toEqual([`Verifying ${config.dataset}`, `Acquiring ${config.dataset}`]);
  });

  it("preserves acquisition failures and leaves the report at the acquisition phase", async () => {
    const error = new Error("Fixture download interrupted");
    vi.mocked(readPinnedOsmSnapshot).mockRejectedValue(missingPin());
    vi.mocked(refreshPinnedOsmSnapshot).mockRejectedValue(error);
    await expect(prepareAndImport()).rejects.toBe(error);
    expect(refreshPinnedOsmSnapshot).toHaveBeenCalledExactlyOnceWith(session.cacheRoot, config);
    expect(CoverageSourceStore).not.toHaveBeenCalled();
    expect(stages()).toEqual([`Verifying ${config.dataset}`, `Acquiring ${config.dataset}`]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
