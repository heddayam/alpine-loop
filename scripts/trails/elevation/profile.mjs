import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { geodesicDistanceMeters } from "../spatial/length.mjs";
import { validateLineString } from "../spatial/geometry.mjs";

/**
 * USGS 3DEP 1/3 arc-second cells are approximately 10 m across in California.
 * Equal-distance sampling uses this as a maximum: each segment is divided into
 * an integer number of intervals so that reversing a line visits the same
 * locations in the opposite order.
 */
export const DEFAULT_SAMPLE_SPACING_METERS = 10;
export const DEFAULT_SMOOTHING_WINDOW_METERS = 30;
export const DEFAULT_NOISE_THRESHOLD_METERS = 1;

export const DEFAULT_ELEVATION_SETTINGS = Object.freeze({
  sampleSpacingMeters: DEFAULT_SAMPLE_SPACING_METERS,
  smoothingWindowMeters: DEFAULT_SMOOTHING_WINDOW_METERS,
  noiseThresholdMeters: DEFAULT_NOISE_THRESHOLD_METERS,
});

function finitePositive(value, path, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${path} must be a ${allowZero ? "non-negative" : "positive"} finite number`);
  }
  return value;
}

function validateSourceMetadata(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("elevation source metadata must be an object");
  }
  for (const field of ["provider", "product", "version"]) {
    if (typeof source[field] !== "string" || !source[field].trim()) {
      throw new TypeError(`elevation source ${field} must be a non-empty string`);
    }
  }
  return { ...source };
}

function normalizeSettings(options = {}) {
  return {
    sampleSpacingMeters: finitePositive(
      options.sampleSpacingMeters ?? DEFAULT_SAMPLE_SPACING_METERS,
      "sampleSpacingMeters",
    ),
    smoothingWindowMeters: finitePositive(
      options.smoothingWindowMeters ?? DEFAULT_SMOOTHING_WINDOW_METERS,
      "smoothingWindowMeters",
      { allowZero: true },
    ),
    noiseThresholdMeters: finitePositive(
      options.noiseThresholdMeters ?? DEFAULT_NOISE_THRESHOLD_METERS,
      "noiseThresholdMeters",
      { allowZero: true },
    ),
  };
}

function interpolateLongitude(start, end, fraction) {
  let delta = end - start;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const longitude = start + delta * fraction;
  if (longitude > 180) return longitude - 360;
  if (longitude < -180) return longitude + 360;
  return longitude;
}

function interpolatePosition(start, end, fraction) {
  return [
    interpolateLongitude(start[0], end[0], fraction),
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

/**
 * Densify a LineString at a maximum spacing. The equal interval count is
 * deliberately symmetric under line reversal, unlike stepping from one end
 * by an exact interval and appending a shorter final interval.
 */
export function elevationSampleLocations(geometry, options = {}) {
  validateLineString(geometry);
  const { sampleSpacingMeters } = normalizeSettings(options);
  const cumulativeDistances = [0];

  for (let index = 1; index < geometry.coordinates.length; index += 1) {
    cumulativeDistances.push(
      cumulativeDistances.at(-1) + geodesicDistanceMeters(
        geometry.coordinates[index - 1],
        geometry.coordinates[index],
      ),
    );
  }

  const totalDistanceMeters = cumulativeDistances.at(-1);
  if (totalDistanceMeters === 0) {
    const [longitude, latitude] = geometry.coordinates[0];
    return [{ distanceMeters: 0, longitude, latitude }];
  }

  const intervalCount = Math.ceil(totalDistanceMeters / sampleSpacingMeters);
  const locations = [];
  let geometryIndex = 1;

  for (let interval = 0; interval <= intervalCount; interval += 1) {
    const distanceMeters = totalDistanceMeters * interval / intervalCount;
    while (
      geometryIndex < cumulativeDistances.length - 1 &&
      cumulativeDistances[geometryIndex] < distanceMeters
    ) {
      geometryIndex += 1;
    }
    const startDistance = cumulativeDistances[geometryIndex - 1];
    const endDistance = cumulativeDistances[geometryIndex];
    const fraction = endDistance === startDistance
      ? 0
      : (distanceMeters - startDistance) / (endDistance - startDistance);
    const [longitude, latitude] = interpolatePosition(
      geometry.coordinates[geometryIndex - 1],
      geometry.coordinates[geometryIndex],
      fraction,
    );
    locations.push({ distanceMeters, longitude, latitude });
  }

  return locations;
}

function rasterSampleFunction(source) {
  if (typeof source === "function") return source;
  if (source && typeof source.sampleElevation === "function") {
    return source.sampleElevation.bind(source);
  }
  if (source && typeof source.sample === "function") return source.sample.bind(source);
  throw new TypeError("elevationSource must be a function or expose sampleElevation(longitude, latitude)");
}

function numericElevation(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    value = value.elevationMeters;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * Sample only a supplied local/cached source. This module intentionally has no
 * HTTP fallback; absent cells are retained as null so downstream metrics are
 * omitted rather than silently converted to zero elevation.
 */
export async function sampleElevationProfile(geometry, elevationSource, options = {}) {
  const settings = normalizeSettings(options);
  const locations = elevationSampleLocations(geometry, settings);
  const sample = rasterSampleFunction(elevationSource);
  const samples = await Promise.all(locations.map(async (location) => ({
    ...location,
    elevationMeters: numericElevation(await sample(location.longitude, location.latitude)),
  })));
  const missingSampleCount = samples.filter(({ elevationMeters }) => elevationMeters === null).length;

  return {
    samples,
    coverage: missingSampleCount === 0 ? "complete" : "missing",
    missingSampleCount,
    sampleSpacingMeters: settings.sampleSpacingMeters,
  };
}

export const sampleLineStringProfile = sampleElevationProfile;

function validateCachedGrid(grid) {
  if (!grid || grid.type !== "ElevationGrid") {
    throw new TypeError("cached elevation grid type must be ElevationGrid");
  }
  if (grid.crs !== "EPSG:4326") {
    throw new TypeError("cached elevation grid crs must be EPSG:4326");
  }
  for (const field of ["width", "height"]) {
    if (!Number.isInteger(grid[field]) || grid[field] < 1) {
      throw new TypeError(`cached elevation grid ${field} must be a positive integer`);
    }
  }
  if (!Array.isArray(grid.origin) || grid.origin.length !== 2 ||
      !grid.origin.every(Number.isFinite)) {
    throw new TypeError("cached elevation grid origin must be [longitude, latitude]");
  }
  if (!Array.isArray(grid.pixelSize) || grid.pixelSize.length !== 2 ||
      !grid.pixelSize.every((value) => Number.isFinite(value) && value !== 0)) {
    throw new TypeError("cached elevation grid pixelSize must contain two non-zero numbers");
  }
  if (!Array.isArray(grid.values) || grid.values.length !== grid.height ||
      grid.values.some((row) => !Array.isArray(row) || row.length !== grid.width)) {
    throw new TypeError("cached elevation grid values must match width and height");
  }
  validateSourceMetadata(grid.source);
  return grid;
}

function isNoData(value, noDataValue) {
  return !Number.isFinite(value) || (noDataValue !== undefined && value === noDataValue);
}

/**
 * Create a bilinear sampler for a small cached WGS84 grid. `origin` is the
 * center of the first cell and `pixelSize` gives signed longitude/latitude
 * increments. Real GeoTIFF decoding can feed the same sampler contract after
 * its raster window has been read from the local cache.
 */
export function createCachedElevationGridSource(grid) {
  validateCachedGrid(grid);
  const [originLongitude, originLatitude] = grid.origin;
  const [pixelLongitude, pixelLatitude] = grid.pixelSize;

  return Object.freeze({
    metadata: Object.freeze(validateSourceMetadata(grid.source)),
    interpolation: "bilinear",
    sampleElevation(longitude, latitude) {
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        throw new TypeError("sample coordinates must be finite numbers");
      }
      const column = (longitude - originLongitude) / pixelLongitude;
      const row = (latitude - originLatitude) / pixelLatitude;
      const epsilon = 1e-9;
      if (column < -epsilon || row < -epsilon ||
          column > grid.width - 1 + epsilon || row > grid.height - 1 + epsilon) {
        return undefined;
      }

      const boundedColumn = Math.max(0, Math.min(grid.width - 1, column));
      const boundedRow = Math.max(0, Math.min(grid.height - 1, row));
      const left = Math.floor(boundedColumn);
      const right = Math.ceil(boundedColumn);
      const top = Math.floor(boundedRow);
      const bottom = Math.ceil(boundedRow);
      const columnFraction = boundedColumn - left;
      const rowFraction = boundedRow - top;
      const weightedCells = [
        [top, left, (1 - rowFraction) * (1 - columnFraction)],
        [top, right, (1 - rowFraction) * columnFraction],
        [bottom, left, rowFraction * (1 - columnFraction)],
        [bottom, right, rowFraction * columnFraction],
      ];
      let elevation = 0;

      for (const [cellRow, cellColumn, weight] of weightedCells) {
        if (weight <= Number.EPSILON) continue;
        const value = grid.values[cellRow][cellColumn];
        if (isNoData(value, grid.noDataValue)) return undefined;
        elevation += value * weight;
      }
      return elevation;
    },
  });
}

function validateTileIndex(index) {
  if (!index || index.type !== "ElevationTileIndex" || index.crs !== "EPSG:4326") {
    throw new TypeError("cached elevation tile index must be an EPSG:4326 ElevationTileIndex");
  }
  for (const field of ["width", "height", "tileSize"]) {
    if (!Number.isInteger(index[field]) || index[field] < 1) {
      throw new TypeError(`cached elevation tile index ${field} must be a positive integer`);
    }
  }
  if (!Array.isArray(index.origin) || index.origin.length !== 2 ||
      !index.origin.every(Number.isFinite)) {
    throw new TypeError("cached elevation tile index origin must be the first cell center");
  }
  if (!Array.isArray(index.pixelSize) || index.pixelSize.length !== 2 ||
      !index.pixelSize.every((value) => Number.isFinite(value) && value !== 0)) {
    throw new TypeError("cached elevation tile index pixelSize must contain two non-zero numbers");
  }
  if (!Array.isArray(index.tiles) || index.tiles.length === 0) {
    throw new TypeError("cached elevation tile index tiles must be a non-empty array");
  }
  const occupied = new Set();
  for (const [tileIndex, tile] of index.tiles.entries()) {
    for (const field of ["row", "column", "rowStart", "columnStart", "width", "height"]) {
      if (!Number.isInteger(tile[field]) || tile[field] < 0 ||
          (["width", "height"].includes(field) && tile[field] < 1)) {
        throw new TypeError(`cached elevation tile ${tileIndex}.${field} is invalid`);
      }
    }
    if (typeof tile.path !== "string" || !tile.path || tile.path.includes("\0")) {
      throw new TypeError(`cached elevation tile ${tileIndex}.path must be a non-empty string`);
    }
    const key = `${tile.row}:${tile.column}`;
    if (occupied.has(key)) throw new TypeError(`duplicate cached elevation tile ${key}`);
    occupied.add(key);
    if (tile.rowStart + tile.height > index.height ||
        tile.columnStart + tile.width > index.width) {
      throw new TypeError(`cached elevation tile ${key} exceeds the raster dimensions`);
    }
  }
  validateSourceMetadata(index.source);
  return index;
}

function float32Value(buffer, index, noDataValue) {
  const value = buffer.readFloatLE(index * 4);
  return isNoData(value, noDataValue) ? undefined : value;
}

/**
 * Create a lazy bilinear sampler over prepared Float32 tiles. Only tiles touched
 * by trail geometry are loaded, and concurrent samples share the same read.
 */
export function createCachedElevationTileSource(index, indexPath) {
  validateTileIndex(index);
  if (typeof indexPath !== "string" || !indexPath) {
    throw new TypeError("indexPath is required for cached elevation tiles");
  }
  const root = dirname(resolve(indexPath));
  const tilesByCell = new Map(index.tiles.map((tile) => [`${tile.row}:${tile.column}`, tile]));
  const cache = new Map();
  const loadTile = (tile) => {
    const key = `${tile.row}:${tile.column}`;
    if (!cache.has(key)) {
      cache.set(key, readFile(resolve(root, tile.path)).then((buffer) => {
        if (buffer.byteLength !== tile.width * tile.height * 4) {
          throw new Error(`elevation tile ${tile.path} has an unexpected byte length`);
        }
        return buffer;
      }));
    }
    return cache.get(key);
  };
  const cell = async (row, column) => {
    if (row < 0 || column < 0 || row >= index.height || column >= index.width) return undefined;
    const tileRow = Math.floor(row / index.tileSize);
    const tileColumn = Math.floor(column / index.tileSize);
    const tile = tilesByCell.get(`${tileRow}:${tileColumn}`);
    if (!tile) return undefined;
    const buffer = await loadTile(tile);
    const localRow = row - tile.rowStart;
    const localColumn = column - tile.columnStart;
    if (localRow < 0 || localColumn < 0 || localRow >= tile.height || localColumn >= tile.width) {
      return undefined;
    }
    return float32Value(buffer, localRow * tile.width + localColumn, index.noDataValue);
  };
  const [originLongitude, originLatitude] = index.origin;
  const [pixelLongitude, pixelLatitude] = index.pixelSize;

  return Object.freeze({
    metadata: Object.freeze(validateSourceMetadata(index.source)),
    interpolation: "bilinear-tiled-float32",
    tileIndex: Object.freeze({
      width: index.width,
      height: index.height,
      tileSize: index.tileSize,
      tileCount: index.tiles.length,
    }),
    async sampleElevation(longitude, latitude) {
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        throw new TypeError("sample coordinates must be finite numbers");
      }
      const column = (longitude - originLongitude) / pixelLongitude;
      const row = (latitude - originLatitude) / pixelLatitude;
      const epsilon = 1e-9;
      if (column < -epsilon || row < -epsilon ||
          column > index.width - 1 + epsilon || row > index.height - 1 + epsilon) {
        return undefined;
      }
      const boundedColumn = Math.max(0, Math.min(index.width - 1, column));
      const boundedRow = Math.max(0, Math.min(index.height - 1, row));
      const left = Math.floor(boundedColumn);
      const right = Math.ceil(boundedColumn);
      const top = Math.floor(boundedRow);
      const bottom = Math.ceil(boundedRow);
      const columnFraction = boundedColumn - left;
      const rowFraction = boundedRow - top;
      const weightedCells = [
        [top, left, (1 - rowFraction) * (1 - columnFraction)],
        [top, right, (1 - rowFraction) * columnFraction],
        [bottom, left, rowFraction * (1 - columnFraction)],
        [bottom, right, rowFraction * columnFraction],
      ];
      let elevation = 0;
      for (const [cellRow, cellColumn, weight] of weightedCells) {
        if (weight <= Number.EPSILON) continue;
        const value = await cell(cellRow, cellColumn);
        if (value === undefined) return undefined;
        elevation += value * weight;
      }
      return elevation;
    },
  });
}

export async function loadCachedElevationGrid(pathOrUrl) {
  const grid = JSON.parse(await readFile(pathOrUrl, "utf8"));
  return createCachedElevationGridSource(grid);
}

export async function loadCachedElevationTiles(indexPath) {
  const absolutePath = resolve(indexPath);
  const index = JSON.parse(await readFile(absolutePath, "utf8"));
  return createCachedElevationTileSource(index, absolutePath);
}

export function elevationManifestMetadata(elevationSource, options = {}) {
  const settings = normalizeSettings(options);
  const source = elevationSource?.metadata ?? elevationSource?.source;
  return {
    source: validateSourceMetadata(source),
    sampling: {
      method: "equal-distance-geodesic",
      maximumSpacingMeters: settings.sampleSpacingMeters,
      interpolation: elevationSource?.interpolation ?? "source-defined",
    },
    smoothing: {
      method: "centered-moving-mean-with-vertical-noise-floor",
      windowMeters: settings.smoothingWindowMeters,
      noiseThresholdMeters: settings.noiseThresholdMeters,
    },
    missingCoverage: "omit-segment-elevation-metrics",
  };
}

export const createElevationManifestMetadata = elevationManifestMetadata;
