import manifest from "@/data/trails/generated/yosemite-stanislaus/manifest.json";
import namedTrails from "@/data/trails/generated/yosemite-stanislaus/named-trails.json";
import accessPointsText from "@/data/trails/generated/yosemite-stanislaus/access-points.geojson?raw";
import segmentIndex from "@/data/trails/generated/yosemite-stanislaus/segments/index.json";
import searchIndex from "./indexes/yosemite-stanislaus.json";
import type {
  AccessPointFeature,
  NamedTrailRecord,
  RegionalTrailCatalog,
  TrailSearchSummary,
  TrailSegment,
} from "./search";

const accessPoints = JSON.parse(accessPointsText) as { features: AccessPointFeature[] };
const shardPaths = Object.fromEntries(Object.entries(segmentIndex.shards).map(([shard, value]) =>
  [shard, value.path]));

const yosemiteStanislaus: RegionalTrailCatalog = {
  manifest: manifest as unknown as RegionalTrailCatalog["manifest"],
  namedTrails: namedTrails.trails as NamedTrailRecord[],
  accessPoints: accessPoints.features as AccessPointFeature[],
  summaries: searchIndex.trails as Record<string, TrailSearchSummary>,
  shardPaths,
};

const CATALOGS: Record<string, RegionalTrailCatalog> = {
  "yosemite-stanislaus": yosemiteStanislaus,
};

export function getRegionalTrailCatalog(regionId: string) {
  return CATALOGS[regionId] ?? null;
}

export async function parseSelectedSegmentNdjson(
  body: ReadableStream<Uint8Array>,
  selectedIds: ReadonlySet<string>,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const selected: TrailSegment[] = [];
  let pending = "";

  const consume = (line: string) => {
    if (!line) return;
    const segment = JSON.parse(line) as TrailSegment;
    if (selectedIds.has(segment.id)) selected.push(segment);
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (done) break;
  }
  consume(pending);
  return selected;
}

export async function loadRegionalSegmentShard(
  regionId: string,
  shard: string,
  selectedIds: ReadonlySet<string>,
  requestUrl: string,
) {
  const catalog = getRegionalTrailCatalog(regionId);
  const artifactPath = catalog?.shardPaths[shard];
  if (!artifactPath) throw new Error(`Unknown geometry shard ${shard}`);
  const { env } = await import("cloudflare:workers");
  const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
  const assetPath = `/trails/${catalog.manifest.region.id}/${artifactPath}`;
  const assetRequest = new Request(new URL(assetPath, requestUrl));
  let response: Response;
  if (!assets && process.env.NODE_ENV === "development") {
    response = await fetch(assetRequest.clone());
  } else {
    if (!assets) throw new Error("Static trail geometry is unavailable.");
    try {
      response = await assets.fetch(assetRequest.clone());
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      response = await fetch(assetRequest.clone());
    }
  }
  if (!response.ok && process.env.NODE_ENV === "development") {
    response = await fetch(assetRequest.clone());
  }
  if (!response.ok || !response.body) {
    throw new Error(`Geometry shard ${shard} could not be loaded.`);
  }
  return parseSelectedSegmentNdjson(response.body, selectedIds);
}
