import path from "node:path";
import type { ElevationSampler } from "../adapters";
import { requireCommand, runCommand, type CommandRunner } from "../osm/command";

export type UvRasterioOptions = {
  projectPath?: string;
  scriptPath?: string;
  runner?: CommandRunner;
};

function resolvedOptions(options: UvRasterioOptions = {}) {
  const projectPath = path.resolve(options.projectPath ?? "tools/dem");
  return {
    projectPath,
    scriptPath: path.resolve(options.scriptPath ?? path.join(projectPath, "sample_dem.py")),
    runner: options.runner ?? runCommand,
  };
}

export async function validateUvRasterioPrerequisites(options: UvRasterioOptions = {}): Promise<{
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
  if (!rasterio.startsWith("rasterio ")) throw new Error("uv DEM environment did not report Rasterio/GDAL versions");
  return { uv, rasterio };
}

export class UvRasterioThreeDepElevationSampler implements ElevationSampler {
  readonly algorithmVersion = "usgs-3dep-13as-rasterio-bilinear+metrics-v2";
  readonly #collectionPath: string;
  readonly #options: ReturnType<typeof resolvedOptions>;

  constructor(collectionPath: string, options: UvRasterioOptions = {}) {
    this.#collectionPath = path.resolve(collectionPath);
    this.#options = resolvedOptions(options);
  }

  async sample(coordinates: ReadonlyArray<readonly [number, number]>): Promise<Array<number | null>> {
    if (coordinates.length === 0) return [];
    const result = await this.#options.runner("uv", [
      "run", "--offline", "--frozen", "--project", this.#options.projectPath,
      "python", this.#options.scriptPath, "--collection", this.#collectionPath,
    ], { stdin: `${coordinates.map(([lon, lat]) => `${lon} ${lat}`).join("\n")}\n` });
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== coordinates.length) {
      throw new Error(`Rasterio returned ${lines.length} elevation rows for ${coordinates.length} coordinates`);
    }
    return lines.map((line, index) => {
      const raw = line.trim();
      if (raw.toLowerCase() === "nan") return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid Rasterio elevation at sample ${index}: ${raw}`);
      return value;
    });
  }
}
