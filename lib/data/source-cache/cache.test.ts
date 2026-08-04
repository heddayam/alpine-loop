import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheLocalFixture } from "./cache";

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
    const first = await cacheLocalFixture(fixture, {
      cacheRoot: path.join(directory, "cache"),
      sourceId: "fixture-source",
      fileName: "source.bin",
      retrievedAt: "2026-08-04T00:00:00.000Z",
    });
    const second = await cacheLocalFixture(fixture, {
      cacheRoot: path.join(directory, "cache"),
      sourceId: "fixture-source",
      fileName: "source.bin",
      expectedSha256: first.receipt.sha256,
    });

    expect(first.receipt).toMatchObject({ byteLength: 15, sourceId: "fixture-source" });
    expect(first.receipt.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.reused).toBe(true);
    expect(JSON.parse(await readFile(first.receiptPath, "utf8"))).toEqual(first.receipt);
  });

  it("rejects a wrong pinned digest without publishing a snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-source-cache-"));
    temporaryDirectories.push(directory);
    const fixture = path.join(directory, "fixture.bin");
    await writeFile(fixture, "fixture");
    await expect(cacheLocalFixture(fixture, {
      cacheRoot: path.join(directory, "cache"),
      sourceId: "fixture-source",
      fileName: "source.bin",
      expectedSha256: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow("SHA-256 mismatch");
  });
});
