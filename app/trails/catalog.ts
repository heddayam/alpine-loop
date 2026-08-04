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
} from "./search";
import { loadTrailSegments } from "./search";
import {
  loadCachedActiveRegionalTrailCatalog,
  loadVerifiedTrailGeometry,
} from "./active-catalog";
import { locateTrailArtifact } from "./artifact-locator";
import { parseSelectedSegmentNdjson } from "./segment-reader";
import {
  createRuntimeTrailArtifactStore,
  TrailArtifactNotFoundError,
} from "./storage";

const accessPoints = JSON.parse(accessPointsText) as { features: AccessPointFeature[] };
const shardPaths = Object.fromEntries(Object.entries(segmentIndex.shards).map(([shard, value]) =>
  [shard, value.path]));
const partitionPrefixLength = "partitioning" in segmentIndex
  ? segmentIndex.partitioning.prefixLength
  : Object.keys(segmentIndex.shards)[0]?.length;
if (!Number.isInteger(partitionPrefixLength) || partitionPrefixLength < 1) {
  throw new TypeError("Trail segment index has no valid partition prefix length");
}

const yosemiteStanislaus: RegionalTrailCatalog = {
  manifest: manifest as unknown as RegionalTrailCatalog["manifest"],
  namedTrails: namedTrails.trails as NamedTrailRecord[],
  accessPoints: accessPoints.features as AccessPointFeature[],
  summaries: searchIndex.trails as Record<string, TrailSearchSummary>,
  shardPaths,
  partitionPrefixLength,
};

const CATALOGS: Record<string, RegionalTrailCatalog> = {
  "yosemite-stanislaus": yosemiteStanislaus,
};

export async function getRegionalTrailCatalog(regionId: string, requestUrl?: string) {
  const packaged = CATALOGS[regionId];
  if (packaged) return packaged;
  if (!requestUrl) return null;
  const { env } = await import("cloudflare:workers");
  const store = createRuntimeTrailArtifactStore(env, requestUrl, "private-r2");
  try {
    return (await loadCachedActiveRegionalTrailCatalog(store, regionId)).catalog;
  } catch (error) {
    if (error instanceof TrailArtifactNotFoundError &&
        error.key === `trails/${regionId}/current.json`) return null;
    throw error;
  }
}

export async function loadRegionalSegmentShard(
  catalog: RegionalTrailCatalog,
  shard: string,
  selectedIds: ReadonlySet<string>,
  requestUrl: string,
) {
  const artifactPath = catalog.shardPaths[shard];
  if (!artifactPath) throw new Error(`Unknown geometry shard ${shard}`);
  const { env } = await import("cloudflare:workers");
  const artifact = locateTrailArtifact(catalog.manifest, artifactPath);
  const store = createRuntimeTrailArtifactStore(env, requestUrl, artifact.backend);
  const object = await store.get(artifact.key, {
    ...(artifact.expectedSha256 ? { expectedSha256: artifact.expectedSha256 } : {}),
  });
  return parseSelectedSegmentNdjson(object.body, selectedIds);
}

export async function loadRegionalTrailGeometry(
  catalog: RegionalTrailCatalog,
  trail: NamedTrailRecord,
  requestUrl: string,
) {
  if (catalog.manifest.schemaVersion === 1) {
    return loadTrailSegments(
      catalog,
      trail.id,
      (shard, selectedIds) => loadRegionalSegmentShard(catalog, shard, selectedIds, requestUrl),
    );
  }
  const { env } = await import("cloudflare:workers");
  const store = createRuntimeTrailArtifactStore(env, requestUrl, "private-r2");
  return loadVerifiedTrailGeometry(store, catalog, trail);
}
