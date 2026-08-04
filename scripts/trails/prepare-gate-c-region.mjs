#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createOSMStream } from "osm-pbf-parser-node";
import { fromArrayBuffer } from "geotiff";
import { requireRegion } from "./regions.mjs";
import { refreshArcGisSnapshot } from "./sources/arcgis.mjs";
import { EBRPD_SOURCE } from "./sources/ebrpd.mjs";
import { NPS_SOURCE } from "./sources/nps.mjs";
import {
  isHikingRelevantWay,
  isOsmPublicRoadWay,
  normalizeOsmTags,
  osmAccessCandidateType,
} from "./sources/osm.mjs";
import { STATE_PARKS_SOURCE } from "./sources/state-parks.mjs";
import { USFS_SOURCE } from "./sources/usfs.mjs";
import { USGS_SOURCE } from "./sources/usgs.mjs";

export const REGION_REFRESH_CONFIG = Object.freeze({
  osmPbfUrl: "https://download.geofabrik.de/north-america/us/california-latest.osm.pbf",
  elevationUrl:
    "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer",
  elevationCellDegrees: 1 / 3_600,
  elevationTileSize: 512,
});

// Retained for callers that still identify the accepted T7.2 workflow by name.
export const GATE_C_REGION = Object.freeze({
  regionId: "yosemite-stanislaus",
  ...REGION_REFRESH_CONFIG,
});

const AGENCY_SOURCES = Object.freeze({
  usgs: USGS_SOURCE,
  usfs: USFS_SOURCE,
  nps: NPS_SOURCE,
  "state-parks": STATE_PARKS_SOURCE,
  ebrpd: EBRPD_SOURCE,
});

export function regionalAgencySources(regionOrId) {
  const region = typeof regionOrId === "string" ? requireRegion(regionOrId) : regionOrId;
  if (!region?.id || !Array.isArray(region.agencyProviders)) {
    throw new TypeError("region must be a configured trail region");
  }
  return region.agencyProviders.map((provider) => {
    const source = AGENCY_SOURCES[provider];
    if (!source) throw new RangeError(`No agency source is registered for ${provider}`);
    return [provider, source];
  });
}

const OSM_NODE_TAGS = Object.freeze([
  "highway", "information", "entrance", "barrier", "amenity", "access", "foot", "name",
]);
const OSM_RELATION_TAGS = Object.freeze(["type", "route", "name", "network", "ref", "operator"]);
const NO_DATA_VALUE = -9_999;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pretty(value) {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

function wayNodeIds(way) {
  return (way.nodes ?? way.refs ?? way.nodeIds ?? []).map(String);
}

function inBounds(longitude, latitude, [west, south, east, north]) {
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

function isHikingRouteRelation(element) {
  const tags = normalizeOsmTags(element.tags);
  return tags.type?.toLowerCase() === "route" &&
    ["hiking", "foot"].includes(tags.route?.toLowerCase());
}

function relationUsesWays(relation, wayIds) {
  return (relation.members ?? []).some((member) =>
    member.type === "way" && wayIds.has(String(member.ref ?? member.id)));
}

function normalizePreparedElement(element) {
  if (element.type === "node") {
    return {
      type: "node",
      id: String(element.id),
      lon: Number(element.lon ?? element.longitude),
      lat: Number(element.lat ?? element.latitude),
      tags: normalizeOsmTags(element.tags),
      ...(element.info ? { info: element.info } : {}),
    };
  }
  if (element.type === "way") {
    return {
      type: "way",
      id: String(element.id),
      nodes: wayNodeIds(element),
      tags: normalizeOsmTags(element.tags),
      ...(element.info ? { info: element.info } : {}),
    };
  }
  return {
    type: "relation",
    id: String(element.id),
    members: (element.members ?? []).map((member) => ({
      type: member.type,
      ref: String(member.ref ?? member.id),
      role: member.role ?? "",
    })),
    tags: normalizeOsmTags(element.tags),
  };
}

/** Pure equivalent of the bounded PBF passes, used by small offline tests. */
export function selectBoundedOsmElements(elements, bbox) {
  const boundedNodeIds = new Set(elements.filter(({ type, lon, lat, longitude, latitude }) =>
    type === "node" && inBounds(Number(lon ?? longitude), Number(lat ?? latitude), bbox))
    .map(({ id }) => String(id)));
  const hikingWays = elements.filter((element) => element.type === "way" &&
    isHikingRelevantWay(element) && wayNodeIds(element).length >= 2 &&
    wayNodeIds(element).every((id) => boundedNodeIds.has(id)));
  const hikingWayIds = new Set(hikingWays.map(({ id }) => String(id)));
  const hikingNodeIds = new Set(hikingWays.flatMap(wayNodeIds));
  const roadWays = elements.filter((element) => element.type === "way" &&
    isOsmPublicRoadWay(element) && wayNodeIds(element).every((id) => boundedNodeIds.has(id)) &&
    wayNodeIds(element).some((id) => hikingNodeIds.has(id)));
  const nodes = elements.filter((element) => element.type === "node" &&
    boundedNodeIds.has(String(element.id)) &&
    (hikingNodeIds.has(String(element.id)) || osmAccessCandidateType(element.tags)));
  const relations = elements.filter((element) => element.type === "relation" &&
    isHikingRouteRelation(element) && relationUsesWays(element, hikingWayIds));
  return [...nodes, ...hikingWays, ...roadWays, ...relations].map(normalizePreparedElement);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileMetadata(filePath, cacheRoot) {
  const details = await stat(filePath);
  return {
    path: relative(cacheRoot, filePath),
    bytes: details.size,
    sha256: await sha256File(filePath),
  };
}

async function fetchResponse(url, options = {}) {
  const attempts = options.attempts ?? 4;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 600_000;
  const { attempts: ignoredAttempts, timeoutMilliseconds: ignoredTimeout, ...fetchOptions } = options;
  void ignoredAttempts;
  void ignoredTimeout;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers: { "User-Agent": "AlpineSearch-TrailRegionRefresh/1", ...options.headers },
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
      if (response.ok) return response;
      const error = new Error(`${response.status} ${response.statusText} for ${url}`);
      if (response.status < 500 && response.status !== 429) {
        error.nonRetryable = true;
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (error.nonRetryable) throw error;
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  const response = await fetchResponse(url);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  return payload;
}

async function downloadFile(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.download`;
  const response = await fetchResponse(url, { timeoutMilliseconds: 3_600_000 });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, destination);
  return destination;
}

async function existingFile(filePath, expectedBytes) {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0 &&
      (expectedBytes === undefined || details.size === expectedBytes);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function passPbf(filePath, parserOptions, visit) {
  for await (const element of createOSMStream(filePath, parserOptions)) await visit(element);
}

/**
 * Three bounded passes over a source PBF. Peak retained state is proportional
 * to the configured region, never to California's public-road network.
 */
export async function extractBoundedOsmPbf(filePath, bbox, retrievedAt) {
  const boundedNodeIds = new Set();
  process.stdout.write("OSM pass 1/3: indexing in-region node IDs\n");
  await passPbf(filePath, {
    withTags: { node: false, way: false, relation: false },
    withInfo: false,
  }, (element) => {
    if (element.type === "node" && inBounds(Number(element.lon), Number(element.lat), bbox)) {
      boundedNodeIds.add(String(element.id));
    }
  });

  const hikingWays = [];
  const boundedPublicRoadWays = [];
  const relations = [];
  const hikingWayIds = new Set();
  const hikingNodeIds = new Set();
  process.stdout.write("OSM pass 2/3: selecting bounded hiking topology and road evidence\n");
  await passPbf(filePath, {
    withTags: { node: false, way: true, relation: OSM_RELATION_TAGS },
    withInfo: true,
  }, (element) => {
    if (element.type === "way") {
      const nodeIds = wayNodeIds(element);
      if (nodeIds.length < 2 || !nodeIds.every((id) => boundedNodeIds.has(id))) return;
      if (isHikingRelevantWay(element)) {
        hikingWays.push(element);
        hikingWayIds.add(String(element.id));
        nodeIds.forEach((id) => hikingNodeIds.add(id));
      } else if (isOsmPublicRoadWay(element)) boundedPublicRoadWays.push(element);
      return;
    }
    if (element.type === "relation" && isHikingRouteRelation(element)) relations.push(element);
  });
  const roadWays = boundedPublicRoadWays.filter((way) =>
    wayNodeIds(way).some((id) => hikingNodeIds.has(id)));
  const selectedRelations = relations.filter((relation) => relationUsesWays(relation, hikingWayIds));
  boundedPublicRoadWays.length = 0;
  relations.length = 0;

  const nodes = [];
  let accessNodeCount = 0;
  process.stdout.write("OSM pass 3/3: materializing referenced nodes and access candidates\n");
  await passPbf(filePath, {
    withTags: { node: OSM_NODE_TAGS, way: false, relation: false },
    withInfo: false,
  }, (element) => {
    if (element.type !== "node" || !boundedNodeIds.has(String(element.id))) return;
    const accessType = osmAccessCandidateType(element.tags);
    if (hikingNodeIds.has(String(element.id)) || accessType) nodes.push(element);
    if (accessType) accessNodeCount += 1;
  });
  const elements = [...nodes, ...hikingWays, ...roadWays, ...selectedRelations]
    .map(normalizePreparedElement);
  return {
    snapshot: { retrievedAt, elements },
    counts: {
      boundedNodeIds: boundedNodeIds.size,
      hikingWays: hikingWays.length,
      hikingNodes: hikingNodeIds.size,
      publicRoadWaysTouchingTrails: roadWays.length,
      accessPointCandidates: accessNodeCount,
      hikingRouteRelations: selectedRelations.length,
      preparedElements: elements.length,
    },
    memoryStrategy: {
      passes: 3,
      rule: "retain-bounded-node-ids-then-bounded-hiking-ways-and-intersecting-road-evidence",
      statewidePublicRoadWaysRetained: 0,
    },
  };
}

function tileLayout(bbox, pixelSize, tileSize) {
  const [west, south, east, north] = bbox;
  const rasterWest = west - pixelSize;
  const rasterNorth = north + pixelSize;
  const width = Math.ceil((east - west + 2 * pixelSize) / pixelSize);
  const height = Math.ceil((north - south + 2 * pixelSize) / pixelSize);
  const tiles = [];
  for (let rowStart = 0; rowStart < height; rowStart += tileSize) {
    for (let columnStart = 0; columnStart < width; columnStart += tileSize) {
      const tileWidth = Math.min(tileSize, width - columnStart);
      const tileHeight = Math.min(tileSize, height - rowStart);
      const tileWest = rasterWest + columnStart * pixelSize;
      const tileEast = tileWest + tileWidth * pixelSize;
      const tileNorth = rasterNorth - rowStart * pixelSize;
      const tileSouth = tileNorth - tileHeight * pixelSize;
      tiles.push({
        row: rowStart / tileSize,
        column: columnStart / tileSize,
        rowStart,
        columnStart,
        width: tileWidth,
        height: tileHeight,
        bounds: [tileWest, tileSouth, tileEast, tileNorth],
      });
    }
  }
  return { rasterWest, rasterNorth, width, height, tiles };
}

function exportImageUrl(baseUrl, tile) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/exportImage`);
  for (const [key, value] of Object.entries({
    bbox: tile.bounds.join(","),
    bboxSR: 4_326,
    imageSR: 4_326,
    size: `${tile.width},${tile.height}`,
    format: "tiff",
    pixelType: "F32",
    interpolation: "RSP_BilinearInterpolation",
    f: "image",
  })) url.searchParams.set(key, String(value));
  return url;
}

async function decodeTiff(bytes, expectedWidth, expectedHeight) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== expectedWidth || image.getHeight() !== expectedHeight) {
    throw new Error(
      `3DEP tile dimensions ${image.getWidth()}x${image.getHeight()} do not match ` +
      `${expectedWidth}x${expectedHeight}`,
    );
  }
  const samplesPerPixel = image.getSamplesPerPixel();
  const raster = await image.readRasters({ interleave: true });
  if (raster.length !== expectedWidth * expectedHeight * samplesPerPixel) {
    throw new Error("3DEP GeoTIFF has an unexpected sample count");
  }
  const declaredNoData = Number(image.getGDALNoData?.());
  const output = Buffer.allocUnsafe(expectedWidth * expectedHeight * 4);
  let noDataCells = 0;
  for (let index = 0; index < expectedWidth * expectedHeight; index += 1) {
    const value = Number(raster[index * samplesPerPixel]);
    const noData = !Number.isFinite(value) ||
      (Number.isFinite(declaredNoData) && value === declaredNoData) || value <= -3.3e38;
    output.writeFloatLE(noData ? NO_DATA_VALUE : value, index * 4);
    if (noData) noDataCells += 1;
  }
  return { output, noDataCells };
}

async function prepareElevationTiles(cacheRoot, bbox, retrievedAt, { reuseCompleted = false } = {}) {
  const root = resolve(cacheRoot, "3dep");
  const rawRoot = resolve(root, "raw");
  const preparedRoot = resolve(root, "tiles");
  await Promise.all([mkdir(rawRoot, { recursive: true }), mkdir(preparedRoot, { recursive: true })]);
  const metadataUrl = new URL(REGION_REFRESH_CONFIG.elevationUrl);
  metadataUrl.searchParams.set("f", "json");
  const serviceMetadata = await fetchJson(metadataUrl);
  const servicePath = resolve(root, "service.json");
  await writeFile(servicePath, pretty(serviceMetadata));
  const layout = tileLayout(
    bbox,
    REGION_REFRESH_CONFIG.elevationCellDegrees,
    REGION_REFRESH_CONFIG.elevationTileSize,
  );
  const tiles = [];
  let noDataCells = 0;
  for (const [position, tile] of layout.tiles.entries()) {
    process.stdout.write(`3DEP tile ${position + 1}/${layout.tiles.length}\n`);
    const rawPath = resolve(rawRoot, `tile-${tile.row}-${tile.column}.tif`);
    const preparedPath = resolve(preparedRoot, `tile-${tile.row}-${tile.column}.f32`);
    let tileNoDataCells = 0;
    if (reuseCompleted && await existingFile(rawPath) &&
        await existingFile(preparedPath, tile.width * tile.height * 4)) {
      const prepared = await readFile(preparedPath);
      for (let offset = 0; offset < prepared.byteLength; offset += 4) {
        if (prepared.readFloatLE(offset) === NO_DATA_VALUE) tileNoDataCells += 1;
      }
    } else {
      const response = await fetchResponse(exportImageUrl(REGION_REFRESH_CONFIG.elevationUrl, tile));
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(rawPath, bytes);
      const decoded = await decodeTiff(bytes, tile.width, tile.height);
      tileNoDataCells = decoded.noDataCells;
      await writeFile(preparedPath, decoded.output);
    }
    noDataCells += tileNoDataCells;
    tiles.push({
      ...tile,
      path: relative(root, preparedPath),
      raw: await fileMetadata(rawPath, cacheRoot),
      prepared: await fileMetadata(preparedPath, cacheRoot),
      sourceUrl: exportImageUrl(REGION_REFRESH_CONFIG.elevationUrl, tile).toString(),
      noDataCells: tileNoDataCells,
    });
  }
  const index = {
    type: "ElevationTileIndex",
    schemaVersion: 1,
    crs: "EPSG:4326",
    width: layout.width,
    height: layout.height,
    tileSize: REGION_REFRESH_CONFIG.elevationTileSize,
    origin: [
      layout.rasterWest + REGION_REFRESH_CONFIG.elevationCellDegrees / 2,
      layout.rasterNorth - REGION_REFRESH_CONFIG.elevationCellDegrees / 2,
    ],
    pixelSize: [
      REGION_REFRESH_CONFIG.elevationCellDegrees,
      -REGION_REFRESH_CONFIG.elevationCellDegrees,
    ],
    noDataValue: NO_DATA_VALUE,
    coverageBounds: [
      layout.rasterWest,
      layout.rasterNorth - layout.height * REGION_REFRESH_CONFIG.elevationCellDegrees,
      layout.rasterWest + layout.width * REGION_REFRESH_CONFIG.elevationCellDegrees,
      layout.rasterNorth,
    ],
    source: {
      provider: "USGS",
      product: "3DEP 1 arc-second dynamic elevation",
      version: retrievedAt.slice(0, 10),
      verticalDatum: "NAVD88",
      sourceUrl: REGION_REFRESH_CONFIG.elevationUrl,
    },
    tiles: tiles.map(({ raw, prepared, sourceUrl, noDataCells: tileNoData, ...tile }) => ({
      ...tile,
      path: relative(root, resolve(cacheRoot, prepared.path)),
      bytes: prepared.bytes,
      sha256: prepared.sha256,
      rawSha256: raw.sha256,
      sourceUrl,
      noDataCells: tileNoData,
    })),
  };
  const indexPath = resolve(root, "index.json");
  await writeFile(indexPath, pretty(index));
  return {
    indexPath,
    servicePath,
    counts: {
      tiles: tiles.length,
      cells: layout.width * layout.height,
      noDataCells,
    },
    files: {
      index: await fileMetadata(indexPath, cacheRoot),
      serviceMetadata: await fileMetadata(servicePath, cacheRoot),
    },
  };
}

async function prepareAgency(cacheRoot, provider, source, bbox, retrievedAt) {
  process.stdout.write(`Refreshing ${provider.toUpperCase()} bounded snapshot\n`);
  const path = resolve(cacheRoot, `${provider}.json`);
  const snapshot = await refreshArcGisSnapshot(source, {
    bbox,
    cachePath: path,
    // Some regional layers advertise record pages large enough to overflow a
    // GET query when expressed as comma-separated object IDs.
    pageSize: source.refreshPageSize ?? 200,
    retrievedAt,
  });
  return {
    provider,
    sourceUrl: source.url,
    bounds: bbox,
    records: snapshot.features.length,
    snapshot: await fileMetadata(path, cacheRoot),
  };
}

/** The only regional workflow that contacts public source services. */
export async function refreshTrailRegion({
  regionId = GATE_C_REGION.regionId,
  cacheDirectory,
  osmPbfPath,
  retrievedAt = new Date().toISOString(),
} = {}) {
  const region = requireRegion(regionId);
  const cacheRoot = resolve(cacheDirectory ?? `.cache/trails/${region.id}`);
  await mkdir(cacheRoot, { recursive: true });
  const inProgressPath = resolve(cacheRoot, ".refresh-in-progress.json");
  const completedPath = resolve(cacheRoot, ".refresh-complete.json");
  const resume = await existingFile(inProgressPath);
  if (resume) {
    const inProgress = JSON.parse(await readFile(inProgressPath, "utf8"));
    if (inProgress.regionId !== region.id) {
      throw new Error(
        `Refresh cache belongs to ${inProgress.regionId}, not requested region ${region.id}`,
      );
    }
    retrievedAt = inProgress.retrievedAt;
  } else {
    await writeFile(inProgressPath, pretty({ regionId: region.id, retrievedAt }));
  }
  const agencies = {};
  for (const [provider, source] of regionalAgencySources(region)) {
    agencies[provider] = await prepareAgency(
      cacheRoot,
      provider,
      source,
      region.bbox,
      retrievedAt,
    );
  }

  const rawPbfPath = osmPbfPath
    ? resolve(osmPbfPath)
    : resolve(cacheRoot, "osm", "california-latest.osm.pbf");
  if (osmPbfPath) {
    if (!await existingFile(rawPbfPath)) {
      throw new Error(`OSM PBF does not exist or is empty: ${rawPbfPath}`);
    }
    process.stdout.write(`Using supplied OSM PBF ${rawPbfPath}\n`);
  } else if (!resume || !await existingFile(rawPbfPath)) {
    process.stdout.write(`Downloading ${REGION_REFRESH_CONFIG.osmPbfUrl}\n`);
    await downloadFile(REGION_REFRESH_CONFIG.osmPbfUrl, rawPbfPath);
  } else {
    process.stdout.write(`Reusing completed OSM download ${rawPbfPath}\n`);
  }
  const osmPath = resolve(cacheRoot, "osm", `${region.id}.json`);
  await mkdir(dirname(osmPath), { recursive: true });
  let osm;
  if (resume && await existingFile(osmPath)) {
    process.stdout.write(`Reusing completed bounded OSM snapshot ${osmPath}\n`);
    const snapshot = JSON.parse(await readFile(osmPath, "utf8"));
    const hikingWays = snapshot.elements.filter((element) =>
      element.type === "way" && isHikingRelevantWay(element));
    const hikingNodeIds = new Set(hikingWays.flatMap(wayNodeIds));
    osm = {
      snapshot,
      counts: {
        materializedNodes: snapshot.elements.filter(({ type }) => type === "node").length,
        hikingWays: hikingWays.length,
        hikingNodes: hikingNodeIds.size,
        publicRoadWaysTouchingTrails: snapshot.elements.filter((element) =>
          element.type === "way" && isOsmPublicRoadWay(element)).length,
        accessPointCandidates: snapshot.elements.filter((element) =>
          element.type === "node" && osmAccessCandidateType(element.tags)).length,
        hikingRouteRelations: snapshot.elements.filter((element) =>
          element.type === "relation").length,
        preparedElements: snapshot.elements.length,
      },
      memoryStrategy: {
        passes: 3,
        rule: "retain-bounded-node-ids-then-bounded-hiking-ways-and-intersecting-road-evidence",
        statewidePublicRoadWaysRetained: 0,
      },
    };
  } else {
    osm = await extractBoundedOsmPbf(rawPbfPath, region.bbox, retrievedAt);
    await writeFile(osmPath, pretty(osm.snapshot));
  }

  const elevation = await prepareElevationTiles(cacheRoot, region.bbox, retrievedAt, {
    reuseCompleted: resume,
  });
  const sourceManifest = {
    schemaVersion: 1,
    region: { id: region.id, label: region.label, bounds: [...region.bbox] },
    retrievedAt,
    sources: {
      ...agencies,
      osm: {
        provider: "OpenStreetMap",
        sourceUrl: REGION_REFRESH_CONFIG.osmPbfUrl,
        bounds: [...region.bbox],
        counts: osm.counts,
        memoryStrategy: osm.memoryStrategy,
        rawPbf: await fileMetadata(rawPbfPath, cacheRoot),
        snapshot: await fileMetadata(osmPath, cacheRoot),
      },
      accessPoints: {
        provider: "OpenStreetMap",
        sourceUrl: REGION_REFRESH_CONFIG.osmPbfUrl,
        records: osm.counts.accessPointCandidates,
        evidence: ["trailhead", "public-entrance", "public-parking", "public-road-intersection"],
        snapshot: relative(cacheRoot, osmPath),
      },
      threeDep: {
        provider: "USGS",
        sourceUrl: REGION_REFRESH_CONFIG.elevationUrl,
        bounds: [...region.bbox],
        representation: "tiled-float32-with-cached-source-geotiffs",
        resolutionArcSeconds: 1,
        counts: elevation.counts,
        ...elevation.files,
      },
    },
  };
  const sourceManifestPath = resolve(cacheRoot, "source-manifest.json");
  await writeFile(sourceManifestPath, pretty(sourceManifest));
  const buildInput = {
    regionId: region.id,
    buildTimestamp: retrievedAt,
    sourceManifestPath: basename(sourceManifestPath),
    agencySnapshots: Object.fromEntries(
      region.agencyProviders.map((provider) => [provider, `${provider}.json`]),
    ),
    osmSnapshotPath: relative(cacheRoot, osmPath),
    elevationTilesPath: relative(cacheRoot, elevation.indexPath),
    reconciliationOptions: {
      snapToleranceMeters: 25,
      minimumCoverageRatio: 0.85,
      maximumGapMeters: 40,
    },
  };
  const buildInputPath = resolve(cacheRoot, "build-input.json");
  await writeFile(buildInputPath, pretty(buildInput));
  await rename(inProgressPath, completedPath);
  return { cacheRoot, buildInputPath, sourceManifest, sourceManifestPath };
}

export function refreshGateCRegion(options = {}) {
  return refreshTrailRegion({ ...options, regionId: GATE_C_REGION.regionId });
}

function commandLineOptions(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(region|cache|osm-pbf)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown argument ${argument}`);
    options[match[1]] = match[2];
  }
  return {
    regionId: options.region,
    cacheDirectory: options.cache,
    osmPbfPath: options["osm-pbf"],
  };
}

async function main() {
  const result = await refreshTrailRegion(commandLineOptions(process.argv.slice(2)));
  process.stdout.write(
    `Prepared ${result.sourceManifest.region.label} inputs in ${result.cacheRoot}\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
