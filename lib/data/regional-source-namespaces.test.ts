import path from "node:path";
import { describe, expect, it } from "vitest";
import { elevationPointerPath, elevationSourceConfigSchema } from "./elevation/source";
import { populationPointerPath, populationSourceConfigSchema } from "./population/source";

const elevation = {
  schemaVersion: 1 as const,
  id: "usgs-3dep-13-arc-second" as const,
  authority: "U.S. Geological Survey" as const,
  dataset: "National Elevation Dataset (NED) 1/3 arc-second",
  catalogId: "USGS:test",
  version: "east-bay-test-v1",
  endpoint: "https://example.test/elevation",
  bbox: [-122.2, 37.3, -121.5, 37.8] as [number, number, number, number],
  productExtent: "1 x 1 degree",
  expectedProductIds: ["product-1"],
  resolution: "1/3 arc-second (nominal 10 m)" as const,
  horizontalDatum: "NAD83" as const,
  verticalDatum: "NAVD88" as const,
  license: "Public domain",
};

const population = {
  schemaVersion: 1 as const,
  id: "ghsl-ghs-pop-r2023a-3ss",
  authority: "European Commission Joint Research Centre" as const,
  dataset: "GHS-POP",
  version: "east-bay-test-v1",
  baseUrl: "https://example.test/population",
  release: "R2023A",
  epoch: 2020,
  productVersion: "V1-0",
  productFileVersion: "V1_0",
  bbox: [-122.2, 37.3, -121.5, 37.8] as [number, number, number, number],
  tilePaddingDegrees: 0.25,
  resolution: "3 arc-second (nominal 90 m)" as const,
  crs: "EPSG:4326" as const,
  license: "Attribution required",
};

describe("regional raster source namespaces", () => {
  it("keeps the existing source-ID pointer path when no namespace is configured", () => {
    const elevationConfig = elevationSourceConfigSchema.parse(elevation);
    const populationConfig = populationSourceConfigSchema.parse(population);

    expect(elevationPointerPath("/cache", elevationConfig)).toBe(path.join("/cache", elevation.id, "pinned.json"));
    expect(populationPointerPath("/cache", populationConfig)).toBe(path.join("/cache", population.id, "pinned.json"));
  });

  it("isolates regional pointers and rejects unsafe namespaces", () => {
    const elevationConfig = elevationSourceConfigSchema.parse({ ...elevation, cacheNamespace: "southern-east-bay-elevation" });
    const populationConfig = populationSourceConfigSchema.parse({ ...population, cacheNamespace: "southern-east-bay-population" });

    expect(elevationPointerPath("/cache", elevationConfig)).toBe("/cache/southern-east-bay-elevation/pinned.json");
    expect(populationPointerPath("/cache", populationConfig)).toBe("/cache/southern-east-bay-population/pinned.json");
    expect(() => elevationSourceConfigSchema.parse({ ...elevation, cacheNamespace: "../escape" })).toThrow();
    expect(() => populationSourceConfigSchema.parse({ ...population, cacheNamespace: "East Bay" })).toThrow();
  });
});
