import { describe, expect, it } from "vitest";
import {
  assertTileBoundsMatch,
  ghslTileBounds,
  ghslTileFileName,
  ghslTilesForBbox,
  ghslTileUrl,
  parseGhslTileKey,
  parsePublishedTileKeys,
  type GhslProduct,
} from "./tiles";

const PRODUCT: GhslProduct = {
  release: "R2023A",
  epoch: 2020,
  version: "V1-0",
  fileVersion: "V1_0",
  baseUrl: "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL",
};

// Read from the georeferencing tags of the published tiles themselves.
const OBSERVED_BOUNDS = {
  R1_C8: [-110.007916, 79.099583, -100.007916, 89.099583],
  R6_C6: [-130.007916, 29.099583, -120.007916, 39.099583],
  R12_C22: [29.992083, -30.900416, 39.992083, -20.900416],
} as const;

describe("ghslTileBounds", () => {
  it.each(Object.entries(OBSERVED_BOUNDS))("matches the published georeferencing of %s", (key, expected) => {
    const bounds = ghslTileBounds(parseGhslTileKey(key));
    for (const [index, value] of expected.entries()) {
      expect(bounds[index]).toBeCloseTo(value, 5);
    }
  });

  it("keeps tiles exactly ten degrees on a side", () => {
    const [west, south, east, north] = ghslTileBounds({ row: 6, column: 6 });
    expect(east - west).toBeCloseTo(10, 9);
    expect(north - south).toBeCloseTo(10, 9);
  });
});

describe("ghslTilesForBbox", () => {
  it("selects the tile containing the Santa Cruz Mountains", () => {
    const tiles = ghslTilesForBbox([-122.57, 36.84, -121.82, 37.44]);
    expect(tiles).toEqual([{ row: 6, column: 6 }]);
  });

  it("includes neighbouring tiles once padding crosses a seam", () => {
    // The C6/C7 seam sits at -120.0079, so a bbox just west of it plus padding
    // must pull in C7 or edge access points would sum a clipped disc.
    const tiles = ghslTilesForBbox([-120.1, 30, -120.05, 30.05], 0.25);
    expect(tiles).toEqual(expect.arrayContaining([{ row: 6, column: 6 }, { row: 6, column: 7 }]));
  });

  it("spans multiple rows and columns for a large bbox", () => {
    const tiles = ghslTilesForBbox([-125, 30, -115, 45]);
    expect(tiles.length).toBeGreaterThan(1);
    for (const tile of tiles) {
      const [west, south, east, north] = ghslTileBounds(tile);
      expect(west).toBeLessThan(east);
      expect(south).toBeLessThan(north);
    }
  });

  it("rejects an inverted bbox", () => {
    expect(() => ghslTilesForBbox([10, 10, 0, 0])).toThrow(/Invalid bbox/);
  });

  it("rejects negative padding", () => {
    expect(() => ghslTilesForBbox([-122, 36, -121, 37], -1)).toThrow(/non-negative/);
  });

  it("does not invent columns beyond the global grid when padding the antimeridian", () => {
    const tiles = ghslTilesForBbox([179.5, 30, 179.9, 30.5], 1);
    expect(tiles.every((tile) => tile.column >= 1 && tile.column <= 36)).toBe(true);
  });
});

describe("ghslTileUrl", () => {
  it("builds the published download path", () => {
    expect(ghslTileFileName(PRODUCT, { row: 6, column: 6 }))
      .toBe("GHS_POP_E2020_GLOBE_R2023A_4326_3ss_V1_0_R6_C6.zip");
    expect(ghslTileUrl(PRODUCT, { row: 6, column: 6 })).toBe(
      "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A"
      + "/GHS_POP_E2020_GLOBE_R2023A_4326_3ss/V1-0/tiles"
      + "/GHS_POP_E2020_GLOBE_R2023A_4326_3ss_V1_0_R6_C6.zip",
    );
  });
});

describe("parsePublishedTileKeys", () => {
  it("reads tile keys out of an FTP directory index", () => {
    const html = `
      <a href="GHS_POP_E2020_GLOBE_R2023A_4326_3ss_V1_0_R6_C6.zip">tile</a>
      <a href="GHS_POP_E2020_GLOBE_R2023A_4326_3ss_V1_0_R1_C8.zip">tile</a>
    `;
    expect(parsePublishedTileKeys(html)).toEqual(new Set(["R6_C6", "R1_C8"]));
  });

  it("fails on an index with no tiles rather than reporting an empty world", () => {
    expect(() => parsePublishedTileKeys("<html>nothing here</html>")).toThrow(/listed no tiles/);
  });
});

describe("assertTileBoundsMatch", () => {
  it("accepts a raster georeferenced where the index predicted", () => {
    expect(() => assertTileBoundsMatch({ row: 6, column: 6 }, OBSERVED_BOUNDS.R6_C6)).not.toThrow();
  });

  it("rejects a raster that is a whole tile away", () => {
    expect(() => assertTileBoundsMatch({ row: 6, column: 6 }, OBSERVED_BOUNDS.R1_C8))
      .toThrow(/west bound is/);
  });
});
