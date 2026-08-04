import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../osm/command";
import { GdalThreeDepElevationSampler } from "./gdal-sampler";
import { queryThreeDepProducts, threeDepQueryUrl } from "./products";
import { UvRasterioThreeDepElevationSampler, validateUvRasterioPrerequisites } from "./uv-rasterio-sampler";

const query = {
  endpoint: "https://tnmaccess.nationalmap.gov/api/v1/products",
  dataset: "Digital Elevation Model (DEM) 1/3 arc-second",
  bbox: [-122.57, 36.84, -121.82, 37.42] as const,
};

describe("USGS 3DEP product ingestion", () => {
  it("uses the exact pack bbox and validates stable product metadata", async () => {
    const body = await readFile(path.resolve("data/fixtures/source/elevation/products.json"), "utf8");
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const products = await queryThreeDepProducts(query, fetchImpl);

    expect(products.map(({ productId }) => productId)).toEqual(["USGS_13_n38w122", "USGS_13_n38w123"]);
    expect(fetchImpl).toHaveBeenCalledWith(threeDepQueryUrl(query));
    expect(products.every(({ format }) => format === "GeoTIFF")).toBe(true);
  });

  it("fails loudly on an empty or drifting product response", async () => {
    await expect(queryThreeDepProducts(query, async () => new Response('{"items":[]}', { status: 200 })))
      .rejects.toThrow("no products");
    await expect(queryThreeDepProducts(query, async () => new Response(JSON.stringify({
      items: [{ sourceId: "bad", title: "Bad product", downloadURL: "https://fixtures.invalid/data.zip" }],
    }), { status: 200 }))).rejects.toThrow("not a GeoTIFF");
    const body = await readFile(path.resolve("data/fixtures/source/elevation/products.json"), "utf8");
    await expect(queryThreeDepProducts({ ...query, expectedProductIds: ["missing-product"] }, async () =>
      new Response(body, { status: 200 }))).rejects.toThrow("missing pinned products");
  });

  it("treats catalog size as advisory because the USGS object response is authoritative", async () => {
    const body = await readFile(path.resolve("data/fixtures/source/elevation/products.json"), "utf8");
    const products = await queryThreeDepProducts(query, async () => new Response(body, { status: 200 }));
    expect(products.every(({ byteLength }) => byteLength === undefined || byteLength > 0)).toBe(true);
  });
});

describe("GDAL elevation sampling", () => {
  it("batches WGS84 samples and preserves missing elevation", async () => {
    const runner: CommandRunner = vi.fn(async (_command, _arguments, options) => {
      expect(options?.stdin).toBe("-122.2 37.2\n-122.1 37.1\n");
      return { stdout: "-122.2,37.2,314.25\n-122.1,37.1,nan\n", stderr: "" };
    });
    const sampler = new GdalThreeDepElevationSampler("/fixture/elevation.vrt", runner);
    await expect(sampler.sample([[-122.2, 37.2], [-122.1, 37.1]])).resolves.toEqual([314.25, null]);
    expect(runner).toHaveBeenCalledWith("gdallocationinfo", expect.arrayContaining(["-wgs84", "bilinear"]), expect.anything());
  });
});

describe("uv-managed Rasterio elevation sampling", () => {
  it("runs the locked environment offline and preserves missing samples", async () => {
    const runner: CommandRunner = vi.fn(async (_command, arguments_, options) => {
      expect(arguments_).toEqual(expect.arrayContaining(["--offline", "--frozen", "--collection"]));
      expect(options?.stdin).toBe("-122.2 37.2\n-122.1 37.1\n");
      return { stdout: "314.25\nnan\n", stderr: "" };
    });
    const sampler = new UvRasterioThreeDepElevationSampler("/fixture/collection.json", {
      projectPath: "/fixture/tools/dem",
      scriptPath: "/fixture/tools/dem/sample_dem.py",
      runner,
    });
    await expect(sampler.sample([[-122.2, 37.2], [-122.1, 37.1]])).resolves.toEqual([314.25, null]);
  });

  it("validates uv and Rasterio versions without network", async () => {
    const runner: CommandRunner = vi.fn(async (_command, arguments_) => arguments_[0] === "--version"
      ? { stdout: "uv 0.9.0\n", stderr: "" }
      : { stdout: "rasterio 1.4.3; GDAL 3.9.3\n", stderr: "" });
    await expect(validateUvRasterioPrerequisites({ runner })).resolves.toEqual({
      uv: "uv 0.9.0",
      rasterio: "rasterio 1.4.3; GDAL 3.9.3",
    });
  });
});
