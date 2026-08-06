/**
 * Tile index for the GHSL GHS-POP 3 arc-second (EPSG:4326) product.
 *
 * GHSL publishes this product as 10 degree x 10 degree GeoTIFF tiles named
 * `..._R{row}_C{column}.zip`. The grid is a clean affine index, but its origin
 * is NOT (-180, 90): it is offset because the WGS84 tiling was aligned to the
 * Mollweide tile scheme. The constants below were read directly from the
 * georeferencing tags of published tiles and cross-checked on three
 * widely-separated tiles:
 *
 *   R1_C8   W=-110.007916 N=89.099583
 *   R6_C6   W=-130.007916 N=39.099583
 *   R12_C22 W=  29.992083 N=-20.900416
 *
 * all of which satisfy west = originLon + (column - 1) * 10 and
 * north = originLat - (row - 1) * 10.
 *
 * Two caveats that matter for future regions:
 *
 *  - GHSL omits tiles that contain no population at all, so a tile this module
 *    predicts may legitimately not exist. Callers must treat an absent tile as
 *    "zero people", not as an error.
 *  - A handful of extra-wide tiles exist past the antimeridian (for example
 *    R21_C36 carries the R3 latitude band and is 12020 px wide). Their row
 *    numbers do not follow the affine index, so this module does not attempt to
 *    predict them. `assertTileBoundsMatch` exists so that a pack straddling the
 *    antimeridian fails loudly instead of silently sampling the wrong place.
 */

export const GHSL_TILE_DEGREES = 10;
export const GHSL_GRID_ORIGIN_LON = -180.00791612933938;
export const GHSL_GRID_ORIGIN_LAT = 89.09958337887517;
/** Nominal 3 arc-second cell, used to size bounds-verification tolerance. */
export const GHSL_CELL_DEGREES = 1 / 1200;

export type GhslTile = { row: number; column: number };
export type Bbox = readonly [west: number, south: number, east: number, north: number];

export function ghslTileBounds(tile: GhslTile): Bbox {
  const west = GHSL_GRID_ORIGIN_LON + (tile.column - 1) * GHSL_TILE_DEGREES;
  const north = GHSL_GRID_ORIGIN_LAT - (tile.row - 1) * GHSL_TILE_DEGREES;
  return [west, north - GHSL_TILE_DEGREES, west + GHSL_TILE_DEGREES, north];
}

export function ghslTileKey(tile: GhslTile): string {
  return `R${tile.row}_C${tile.column}`;
}

export function parseGhslTileKey(key: string): GhslTile {
  const match = /^R(\d+)_C(\d+)$/.exec(key);
  if (!match) throw new Error(`Invalid GHSL tile key: ${key}`);
  return { row: Number(match[1]), column: Number(match[2]) };
}

/**
 * Every tile whose 10-degree cell intersects `bbox` after expanding it by
 * `paddingDegrees`. The padding must cover the sampling radius, otherwise
 * access points near the pack edge would sum a disc that is silently clipped at
 * the tile seam and read as less populated than they are.
 */
export function ghslTilesForBbox(bbox: Bbox, paddingDegrees = 0): GhslTile[] {
  const [west, south, east, north] = bbox;
  if (!(west <= east) || !(south <= north)) throw new Error(`Invalid bbox for GHSL tile lookup: ${bbox.join(",")}`);
  if (!Number.isFinite(paddingDegrees) || paddingDegrees < 0) throw new Error("GHSL tile padding must be a non-negative number");
  const paddedWest = west - paddingDegrees;
  const paddedEast = east + paddingDegrees;
  const paddedSouth = Math.max(-90, south - paddingDegrees);
  const paddedNorth = Math.min(90, north + paddingDegrees);

  const columnOf = (lon: number): number =>
    Math.floor((lon - GHSL_GRID_ORIGIN_LON) / GHSL_TILE_DEGREES) + 1;
  const rowOf = (lat: number): number =>
    Math.floor((GHSL_GRID_ORIGIN_LAT - lat) / GHSL_TILE_DEGREES) + 1;

  const tiles: GhslTile[] = [];
  const firstRow = rowOf(paddedNorth);
  const lastRow = rowOf(paddedSouth);
  const firstColumn = columnOf(paddedWest);
  const lastColumn = columnOf(paddedEast);
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      // Rows/columns outside the published global grid cannot exist; skipping
      // them keeps antimeridian and polar padding from inventing tile names.
      if (row < 1 || column < 1 || column > 360 / GHSL_TILE_DEGREES) continue;
      const [, tileSouth, , tileNorth] = ghslTileBounds({ row, column });
      if (tileNorth < -90 || tileSouth > 90) continue;
      tiles.push({ row, column });
    }
  }
  if (tiles.length === 0) throw new Error(`No GHSL tiles cover bbox ${bbox.join(",")}`);
  return tiles;
}

export type GhslProduct = {
  /** Release identifier, e.g. "R2023A". */
  release: string;
  /** Epoch year, e.g. 2020. */
  epoch: number;
  /** Product version directory, e.g. "V1-0". */
  version: string;
  /** Filename version fragment, e.g. "V1_0". */
  fileVersion: string;
  baseUrl: string;
};

export function ghslProductDirectoryUrl(product: GhslProduct): string {
  const dataset = `GHS_POP_E${product.epoch}_GLOBE_${product.release}_4326_3ss`;
  return `${product.baseUrl.replace(/\/$/, "")}/GHS_POP_GLOBE_${product.release}/${dataset}/${product.version}/tiles/`;
}

export function ghslTileFileName(product: GhslProduct, tile: GhslTile): string {
  return `GHS_POP_E${product.epoch}_GLOBE_${product.release}_4326_3ss_${product.fileVersion}_${ghslTileKey(tile)}.zip`;
}

export function ghslTileUrl(product: GhslProduct, tile: GhslTile): string {
  return `${ghslProductDirectoryUrl(product)}${ghslTileFileName(product, tile)}`;
}

/**
 * Tile keys present in a GHSL FTP directory index. GHSL omits all-zero tiles,
 * so this is the authority on which predicted tiles actually exist.
 */
export function parsePublishedTileKeys(directoryHtml: string): Set<string> {
  const keys = new Set<string>();
  for (const match of directoryHtml.matchAll(/_(R\d+_C\d+)\.zip/g)) keys.add(match[1]);
  if (keys.size === 0) throw new Error("GHSL tile directory index listed no tiles");
  return keys;
}

/**
 * Fails when a downloaded raster is not georeferenced where the tile index said
 * it would be. This is the guard that stops a future region from silently
 * sampling population from the wrong part of the world.
 */
export function assertTileBoundsMatch(tile: GhslTile, actual: Bbox): void {
  const expected = ghslTileBounds(tile);
  const tolerance = GHSL_CELL_DEGREES;
  const labels = ["west", "south", "east", "north"] as const;
  for (const [index, label] of labels.entries()) {
    // East may legitimately overshoot on the antimeridian-extended tiles.
    const difference = Math.abs(actual[index] - expected[index]);
    if (difference > tolerance) {
      throw new Error(
        `GHSL tile ${ghslTileKey(tile)} ${label} bound is ${actual[index]}, expected ${expected[index]} `
        + `(difference ${difference.toFixed(6)} deg exceeds ${tolerance.toFixed(6)} deg tolerance)`,
      );
    }
  }
}
