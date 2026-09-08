import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheLocalFixture, downloadToSourceCache, type CacheDownloadOptions } from "./cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("immutable source cache", () => {
  it("captures SHA-256, size and retrieval metadata, then reuses the immutable snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-source-cache-"));
    temporaryDirectories.push(directory);
    const fixture = path.join(directory, "fixture.bin");
    await writeFile(fixture, "pinned fixture\n");
    const progress: Parameters<NonNullable<CacheDownloadOptions["onProgress"]>>[0][] = [];
    const first = await cacheLocalFixture(fixture, {
      cacheRoot: path.join(directory, "cache"),
      sourceId: "fixture-source",
      fileName: "source.bin",
      retrievedAt: "2026-08-04T00:00:00.000Z",
      onProgress: (value) => progress.push(value),
    });
    const second = await cacheLocalFixture(fixture, {
      cacheRoot: path.join(directory, "cache"),
      sourceId: "fixture-source",
      fileName: "source.bin",
      expectedSha256: first.receipt.sha256,
      onProgress: (value) => progress.push(value),
    });

    expect(first.receipt).toMatchObject({ byteLength: 15, sourceId: "fixture-source" });
    expect(first.receipt.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.reused).toBe(true);
    expect(progress[0]).toMatchObject({ receivedBytes: 0, totalBytes: 15, state: "downloading" });
    expect(progress.slice(-2)).toMatchObject([
      { receivedBytes: 15, totalBytes: 15, state: "complete" },
      { receivedBytes: 15, totalBytes: 15, state: "cached" },
    ]);
    expect(JSON.parse(await readFile(first.receiptPath, "utf8"))).toEqual(first.receipt);
  });

  it("rejects a wrong pinned digest without publishing a snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-source-cache-"));
    temporaryDirectories.push(directory);
    const fixture = path.join(directory, "fixture.bin");
    await writeFile(fixture, "fixture");
    const states: string[] = [];
    await expect(cacheLocalFixture(fixture, {
      cacheRoot: path.join(directory, "cache"),
      sourceId: "fixture-source",
      fileName: "source.bin",
      expectedSha256: `sha256:${"0".repeat(64)}`,
      onProgress: ({ state }) => states.push(state),
    })).rejects.toThrow("SHA-256 mismatch");
    expect(states).not.toContain("complete");
  });

  it("can reuse a verified immutable object by its stable upstream URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-source-cache-"));
    temporaryDirectories.push(directory);
    const fetchImpl = async () => new Response("immutable product", { status: 200 });
    const progress: Parameters<NonNullable<CacheDownloadOptions["onProgress"]>>[0][] = [];
    const first = await downloadToSourceCache({
      cacheRoot: path.join(directory, "cache"),
      sourceId: "usgs-product-1",
      url: "https://fixtures.invalid/historical/product.tif",
      fileName: "product.tif",
      fetchImpl,
      onProgress: (value) => progress.push(value),
    });
    const second = await downloadToSourceCache({
      cacheRoot: path.join(directory, "cache"),
      sourceId: "usgs-product-1",
      url: "https://fixtures.invalid/historical/product.tif",
      fileName: "product.tif",
      reuseExistingUrl: true,
      onProgress: (value) => progress.push(value),
      fetchImpl: async () => {
        throw new Error("immutable product should not be downloaded twice");
      },
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.receipt.sha256).toBe(first.receipt.sha256);
    expect(progress[0]).toMatchObject({ receivedBytes: 0, totalBytes: undefined, state: "downloading" });
    expect(progress.at(-1)).toMatchObject({ receivedBytes: 17, totalBytes: 17, state: "cached" });
  });
});
