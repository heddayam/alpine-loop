import path from "node:path";
import { requireCommand, runCommand, type CommandRunner } from "../osm/command";
import { assertCollectionMatchesTileIndex, type PopulationCollection, type RasterDescription } from "./collection";
import type { Bbox } from "./tiles";

export type UvRasterioOptions = {
  projectPath?: string;
  scriptPath?: string;
  runner?: CommandRunner;
};

function resolvedOptions(options: UvRasterioOptions = {}) {
  const projectPath = path.resolve(options.projectPath ?? "tools/dem");
  return {
    projectPath,
    scriptPath: path.resolve(options.scriptPath ?? path.join(projectPath, "sample_population.py")),
    runner: options.runner ?? runCommand,
  };
}

export async function validateUvRasterioPopulationPrerequisites(options: UvRasterioOptions = {}): Promise<{
  uv: string;
  rasterio: string;
}> {
  const resolved = resolvedOptions(options);
  const uv = await requireCommand("uv", resolved.runner);
  const result = await resolved.runner("uv", [
    "run", "--offline", "--frozen", "--project", resolved.projectPath,
    "python", resolved.scriptPath, "--version",
  ]);
  const rasterio = result.stdout.trim();
  if (!rasterio.startsWith("rasterio ")) throw new Error("uv population environment did not report Rasterio/GDAL versions");
  return { uv, rasterio };
}

/**
 * People living within a radius of each coordinate, read from GHS-POP.
 *
 * Deliberately not shaped like `ElevationSampler`: population is a count per
 * cell, so the useful query is a windowed sum over a radius rather than an
 * interpolated point value. A trailhead at the edge of a subdivision sits in a
 * near-zero cell while thousands of people live 300 m away, and a point sample
 * would call that remote.
 */
export interface PopulationSampler {
  readonly algorithmVersion: string;
  readonly radiusM: number;
  sample(coordinates: ReadonlyArray<readonly [number, number]>): Promise<Array<number | null>>;
}

export class UvRasterioPopulationSampler implements PopulationSampler {
  readonly algorithmVersion: string;
  readonly radiusM: number;
  readonly #collectionPath: string;
  readonly #options: ReturnType<typeof resolvedOptions>;

  constructor(collectionPath: string, radiusM: number, options: UvRasterioOptions = {}) {
    if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error("Population sampling radius must be a positive number");
    this.#collectionPath = path.resolve(collectionPath);
    this.#options = resolvedOptions(options);
    this.radiusM = radiusM;
    this.algorithmVersion = `ghs-pop-r2023a-3ss-disc-sum-${Math.round(radiusM)}m-v1`;
  }

  async describeRasters(): Promise<RasterDescription[]> {
    const result = await this.#options.runner("uv", [
      "run", "--offline", "--frozen", "--project", this.#options.projectPath,
      "python", this.#options.scriptPath, "--collection", this.#collectionPath, "--describe",
    ]);
    return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
      const parsed = JSON.parse(line) as { fileName: string; epsg: number | null; bounds: number[]; width: number; height: number };
      return {
        fileName: parsed.fileName,
        epsg: parsed.epsg,
        bounds: parsed.bounds as unknown as Bbox,
        width: parsed.width,
        height: parsed.height,
      };
    });
  }

  /** Verifies the downloaded rasters really sit where the tile index predicted. */
  async verify(collection: PopulationCollection): Promise<void> {
    assertCollectionMatchesTileIndex(collection, await this.describeRasters());
  }

  async sample(coordinates: ReadonlyArray<readonly [number, number]>): Promise<Array<number | null>> {
    if (coordinates.length === 0) return [];
    const result = await this.#options.runner("uv", [
      "run", "--offline", "--frozen", "--project", this.#options.projectPath,
      "python", this.#options.scriptPath, "--collection", this.#collectionPath,
      "--radius-m", String(this.radiusM),
    ], { stdin: `${coordinates.map(([lon, lat]) => `${lon} ${lat}`).join("\n")}\n` });
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== coordinates.length) {
      throw new Error(`Rasterio returned ${lines.length} population rows for ${coordinates.length} coordinates`);
    }
    return lines.map((line, index) => {
      const raw = line.trim();
      if (raw.toLowerCase() === "nan") return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid population sample at index ${index}: ${raw}`);
      return value;
    });
  }
}
