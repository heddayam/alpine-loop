import { z } from "zod";

export type ThreeDepProduct = {
  productId: string;
  title: string;
  downloadUrl: string;
  publicationDate: string;
  byteLength?: number;
  format: string;
};

const productSchema = z.object({
  sourceId: z.union([z.string(), z.number()]).optional(),
  productId: z.union([z.string(), z.number()]).optional(),
  title: z.string().min(1),
  downloadURL: z.string().url().optional(),
  downloadUrl: z.string().url().optional(),
  publicationDate: z.string().optional(),
  lastUpdated: z.string().optional(),
  sizeInBytes: z.union([z.number(), z.string()]).optional(),
  format: z.string().optional(),
}).passthrough();

const responseSchema = z.object({
  items: z.array(productSchema),
  total: z.number().int().nonnegative().optional(),
}).passthrough();

export type ThreeDepQuery = {
  endpoint: string;
  dataset: string;
  bbox: readonly [west: number, south: number, east: number, north: number];
  productExtent?: string;
  expectedProductIds?: readonly string[];
};

export function threeDepQueryUrl(query: ThreeDepQuery): string {
  const url = new URL(query.endpoint);
  url.searchParams.set("datasets", query.dataset);
  url.searchParams.set("bbox", query.bbox.join(","));
  url.searchParams.set("outputFormat", "JSON");
  url.searchParams.set("max", "100");
  if (query.productExtent) url.searchParams.set("prodExtents", query.productExtent);
  return url.toString();
}

export async function queryThreeDepProducts(
  query: ThreeDepQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreeDepProduct[]> {
  const url = threeDepQueryUrl(query);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`USGS 3DEP product query failed: HTTP ${response.status}`);
  const parsed = responseSchema.parse(await response.json());
  let products = parsed.items.map((raw): ThreeDepProduct => {
    const productId = raw.sourceId ?? raw.productId;
    const downloadUrl = raw.downloadURL ?? raw.downloadUrl;
    if (productId === undefined) throw new Error(`USGS product ${raw.title} has no product identifier`);
    if (!downloadUrl) throw new Error(`USGS product ${productId} has no download URL`);
    if (!/\.tiff?(?:$|\?)/i.test(downloadUrl)) throw new Error(`USGS product ${productId} is not a GeoTIFF`);
    const size = raw.sizeInBytes === undefined ? undefined : Number(raw.sizeInBytes);
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) {
      throw new Error(`USGS product ${productId} has invalid size`);
    }
    return {
      productId: String(productId),
      title: raw.title,
      downloadUrl,
      publicationDate: raw.publicationDate ?? raw.lastUpdated ?? "unknown",
      ...(size === undefined ? {} : { byteLength: size }),
      format: raw.format ?? "GeoTIFF",
    };
  });
  if (products.length === 0) throw new Error("USGS 3DEP query returned no products for the pack boundary");
  const identifiers = new Set(products.map(({ productId }) => productId));
  if (identifiers.size !== products.length) throw new Error("USGS 3DEP query returned duplicate product identifiers");
  if (query.expectedProductIds) {
    const expected = new Set(query.expectedProductIds);
    const missing = [...expected].filter((productId) => !identifiers.has(productId));
    if (missing.length > 0) throw new Error(`USGS 3DEP query is missing pinned products: ${missing.join(", ")}`);
    products = products.filter(({ productId }) => expected.has(productId));
    if (products.length !== expected.size) throw new Error("USGS 3DEP pinned product selection was not one-to-one");
  }
  return products.sort((left, right) => left.productId.localeCompare(right.productId));
}
