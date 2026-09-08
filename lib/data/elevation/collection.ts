import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { downloadToSourceCache, withAtomicDirectory, type SourceReceipt, type CacheDownloadOptions } from "../source-cache";
import { queryThreeDepProducts, threeDepQueryUrl, type ThreeDepQuery } from "./products";

export const threeDepCollectionSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.literal("usgs-3dep-13-arc-second"),
  authority: z.literal("U.S. Geological Survey"),
  dataset: z.string().min(1),
  catalogId: z.string().min(1),
  resolution: z.literal("1/3 arc-second (nominal 10 m)"),
  horizontalDatum: z.literal("NAD83"),
  verticalDatum: z.literal("NAVD88"),
  retrievedAt: z.string().datetime(),
  queryUrl: z.string().url(),
  license: z.string().min(1),
  products: z.array(z.object({
    productId: z.string().min(1),
    title: z.string().min(1),
    publicationDate: z.string().min(1),
    filePath: z.string().min(1),
    receipt: z.object({
      schemaVersion: z.literal(1), sourceId: z.string(), originalUrl: z.string().url(), resolvedUrl: z.string().url(),
      retrievedAt: z.string().datetime(), byteLength: z.number().int().positive(),
      sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/), fileName: z.string(),
      etag: z.string().optional(), lastModified: z.string().optional(),
    }).strict(),
  }).strict()).min(1),
}).strict();

export type ThreeDepCollection = z.infer<typeof threeDepCollectionSchema>;

export type RefreshThreeDepOptions = {
  cacheRoot: string;
  collectionRoot: string;
  query: ThreeDepQuery;
  catalogId: string;
  retrievedAt?: string;
  fetchImpl?: typeof fetch;
  onProgress?: CacheDownloadOptions["onProgress"];
};

function tifFileName(productId: string, downloadUrl: string): string {
  const fromUrl = path.basename(new URL(downloadUrl).pathname);
  const safe = fromUrl.replace(/[^a-zA-Z0-9._-]/g, "-");
  return /\.tiff?$/i.test(safe) ? safe : `${productId.replace(/[^a-zA-Z0-9._-]/g, "-")}.tif`;
}

export async function refreshThreeDepCollection(options: RefreshThreeDepOptions): Promise<{
  collection: ThreeDepCollection;
  collectionPath: string;
}> {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const products = await queryThreeDepProducts(options.query, options.fetchImpl);
  const cached = [] as Array<{
    productId: string;
    title: string;
    publicationDate: string;
    filePath: string;
    receipt: SourceReceipt;
  }>;
  for (const product of products) {
    const source = await downloadToSourceCache({
      cacheRoot: options.cacheRoot,
      sourceId: `usgs-3dep-${product.productId.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
      url: product.downloadUrl,
      fileName: tifFileName(product.productId, product.downloadUrl),
      retrievedAt,
      reuseExistingUrl: true,
      onProgress: options.onProgress,
      ...(product.byteLength ? { expectedByteLength: product.byteLength } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    cached.push({
      productId: product.productId,
      title: product.title,
      publicationDate: product.publicationDate,
      filePath: source.filePath,
      receipt: source.receipt,
    });
  }
  const identity = createHash("sha256")
    .update(cached.map(({ productId, receipt }) => `${productId}:${receipt.sha256}`).join("\n"))
    .digest("hex").slice(0, 24);
  const destination = path.join(options.collectionRoot, identity);
  const collectionPath = path.join(destination, "collection.json");
  const collection = threeDepCollectionSchema.parse({
    schemaVersion: 1,
    sourceId: "usgs-3dep-13-arc-second",
    authority: "U.S. Geological Survey",
    dataset: options.query.dataset,
    catalogId: options.catalogId,
    resolution: "1/3 arc-second (nominal 10 m)",
    horizontalDatum: "NAD83",
    verticalDatum: "NAVD88",
    retrievedAt,
    queryUrl: threeDepQueryUrl(options.query),
    license: "U.S. public domain; https://www.usa.gov/publicdomain/label/1.0/",
    products: cached.map((product) => ({
      ...product,
      filePath: path.relative(destination, product.filePath),
    })),
  });
  try {
    return { collection: await readThreeDepCollection(collectionPath), collectionPath };
  } catch {
    await withAtomicDirectory(destination, async (staging) => {
      await writeFile(path.join(staging, "collection.json"), `${JSON.stringify(collection, null, 2)}\n`, { flag: "wx" });
    });
    return { collection, collectionPath };
  }
}

export async function readThreeDepCollection(collectionPath: string): Promise<ThreeDepCollection> {
  return threeDepCollectionSchema.parse(JSON.parse(await readFile(collectionPath, "utf8")));
}
