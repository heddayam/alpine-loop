import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { CachedSource, SourceReceipt } from "./types";

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.string().min(1),
  originalUrl: z.string().url(),
  resolvedUrl: z.string().url(),
  retrievedAt: z.string().datetime(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  fileName: z.string().min(1),
  etag: z.string().min(1).optional(),
  lastModified: z.string().min(1).optional(),
}).strict();

export type CacheDownloadOptions = {
  cacheRoot: string;
  sourceId: string;
  url: string;
  fileName: string;
  retrievedAt?: string;
  expectedSha256?: `sha256:${string}`;
  expectedByteLength?: number;
  /** Reuse a verified immutable object with the same original URL. */
  reuseExistingUrl?: boolean;
  fetchImpl?: typeof fetch;
};

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`Unsafe cache path segment: ${value}`);
  }
  return value;
}

async function reusableSnapshot(directory: string, expectedSha256?: string): Promise<CachedSource | null> {
  try {
    const receiptPath = path.join(directory, "receipt.json");
    const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8"))) as SourceReceipt;
    if (expectedSha256 && receipt.sha256 !== expectedSha256) return null;
    const filePath = path.join(directory, receipt.fileName);
    const fileStat = await stat(filePath);
    if (fileStat.size !== receipt.byteLength) return null;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    if (`sha256:${hash.digest("hex")}` !== receipt.sha256) return null;
    return { directory, filePath, receiptPath, receipt, reused: true };
  } catch {
    return null;
  }
}

export async function downloadToSourceCache(options: CacheDownloadOptions): Promise<CachedSource> {
  const sourceId = safeSegment(options.sourceId);
  const fileName = safeSegment(options.fileName);
  const sourceRoot = path.join(options.cacheRoot, sourceId);
  await mkdir(sourceRoot, { recursive: true });

  if (options.expectedSha256) {
    const expectedDirectory = path.join(sourceRoot, options.expectedSha256.slice("sha256:".length));
    const reusable = await reusableSnapshot(expectedDirectory, options.expectedSha256);
    if (reusable) return reusable;
  }

  if (options.reuseExistingUrl) {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const reusable = await reusableSnapshot(path.join(sourceRoot, entry.name));
      if (reusable?.receipt.originalUrl !== options.url) continue;
      if (options.expectedByteLength !== undefined && reusable.receipt.byteLength !== options.expectedByteLength) continue;
      return reusable;
    }
  }

  const temporaryPath = path.join(sourceRoot, `.download-${randomUUID()}`);
  const response = await (options.fetchImpl ?? fetch)(options.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${options.sourceId}: HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  let snapshotStaging: string | null = null;
  try {
    await pipeline(Readable.fromWeb(response.body as never), measure, createWriteStream(temporaryPath, { flags: "wx" }));
    if (byteLength === 0) throw new Error(`Download for ${options.sourceId} was empty`);
    const sha256 = `sha256:${hash.digest("hex")}` as const;
    if (options.expectedSha256 && sha256 !== options.expectedSha256) {
      throw new Error(`SHA-256 mismatch for ${options.sourceId}: expected ${options.expectedSha256}, got ${sha256}`);
    }
    if (options.expectedByteLength !== undefined && byteLength !== options.expectedByteLength) {
      throw new Error(`Size mismatch for ${options.sourceId}: expected ${options.expectedByteLength}, got ${byteLength}`);
    }
    const directory = path.join(sourceRoot, sha256.slice("sha256:".length));
    const reusable = await reusableSnapshot(directory, sha256);
    if (reusable) {
      await rm(temporaryPath, { force: true });
      return reusable;
    }
    snapshotStaging = path.join(sourceRoot, `.snapshot-${sha256.slice(7, 23)}-${randomUUID()}`);
    const stagingDirectory = snapshotStaging;
    await mkdir(stagingDirectory);
    const stagedFilePath = path.join(stagingDirectory, fileName);
    await rename(temporaryPath, stagedFilePath);
    const receipt: SourceReceipt = {
      schemaVersion: 1,
      sourceId: options.sourceId,
      originalUrl: options.url,
      resolvedUrl: response.url || options.url,
      retrievedAt: options.retrievedAt ?? new Date().toISOString(),
      byteLength,
      sha256,
      fileName,
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    };
    const stagedReceiptPath = path.join(stagingDirectory, "receipt.json");
    await writeFile(stagedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    try {
      await rename(stagingDirectory, directory);
      snapshotStaging = null;
    } catch (error) {
      const winner = await reusableSnapshot(directory, sha256);
      await rm(stagingDirectory, { recursive: true, force: true });
      snapshotStaging = null;
      if (winner) return winner;
      throw error;
    }
    const filePath = path.join(directory, fileName);
    const receiptPath = path.join(directory, "receipt.json");
    return { directory, filePath, receiptPath, receipt, reused: false };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (snapshotStaging) await rm(snapshotStaging, { recursive: true, force: true });
    throw error;
  }
}

export async function cacheLocalFixture(
  inputPath: string,
  options: Omit<CacheDownloadOptions, "url" | "fetchImpl"> & { url?: string },
): Promise<CachedSource> {
  await access(inputPath);
  const fileStat = await stat(inputPath);
  const response = new Response(Readable.toWeb(createReadStream(inputPath)) as never, {
    status: 200,
    headers: { "content-length": String(fileStat.size) },
  });
  Object.defineProperty(response, "url", { value: options.url ?? "https://fixtures.invalid/source" });
  return downloadToSourceCache({
    ...options,
    url: options.url ?? "https://fixtures.invalid/source",
    fetchImpl: async () => response,
  });
}
