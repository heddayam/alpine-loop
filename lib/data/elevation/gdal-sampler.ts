import { constants } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElevationSampler } from "../adapters";
import { sha256File } from "../file-source";
import { requireCommand, runCommand, type CommandRunner } from "../osm/command";
import { withAtomicDirectory } from "../source-cache";
import { readThreeDepCollection } from "./collection";

export async function validateGdalPrerequisites(runner: CommandRunner = runCommand): Promise<{
  gdalbuildvrt: string;
  gdallocationinfo: string;
}> {
  return {
    gdalbuildvrt: await requireCommand("gdalbuildvrt", runner),
    gdallocationinfo: await requireCommand("gdallocationinfo", runner),
  };
}

export async function prepareThreeDepVrt(
  collectionPath: string,
  preparationRoot: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  await validateGdalPrerequisites(runner);
  const collection = await readThreeDepCollection(collectionPath);
  const collectionHash = await sha256File(collectionPath);
  const outputDirectory = path.join(preparationRoot, collectionHash.slice(7, 31));
  const vrtPath = path.join(outputDirectory, "elevation.vrt");
  try {
    await access(vrtPath, constants.R_OK);
    if ((await stat(vrtPath)).size > 0) return vrtPath;
  } catch {
    // Continue with an atomic first preparation.
  }
  await withAtomicDirectory(outputDirectory, async (staging) => {
    const inputList = path.join(staging, "inputs.txt");
    const stagedVrt = path.join(staging, "elevation.vrt");
    const collectionDirectory = path.dirname(collectionPath);
    await writeFile(inputList, `${collection.products
      .map(({ filePath }) => path.resolve(collectionDirectory, filePath))
      .join("\n")}\n`, { flag: "wx" });
    await runner("gdalbuildvrt", ["-input_file_list", inputList, stagedVrt]);
    if ((await stat(stagedVrt)).size === 0) throw new Error("GDAL produced an empty elevation VRT");
  });
  return vrtPath;
}

export class GdalThreeDepElevationSampler implements ElevationSampler {
  readonly algorithmVersion = "usgs-3dep-13as-bilinear+metrics-v2";

  constructor(
    private readonly vrtPath: string,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  async sample(coordinates: ReadonlyArray<readonly [number, number]>): Promise<Array<number | null>> {
    if (coordinates.length === 0) return [];
    const stdin = coordinates.map(([lon, lat]) => `${lon} ${lat}`).join("\n") + "\n";
    const result = await this.runner("gdallocationinfo", [
      "-wgs84", "-valonly", "-E", "-field_sep", ",", "-r", "bilinear", this.vrtPath,
    ], { stdin });
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== coordinates.length) {
      throw new Error(`GDAL returned ${lines.length} elevation rows for ${coordinates.length} coordinates`);
    }
    return lines.map((line, index) => {
      const columns = line.split(",");
      const raw = columns.at(-1)?.trim() ?? "";
      if (!raw || raw.toLowerCase() === "nan") return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid GDAL elevation at sample ${index}: ${raw}`);
      return value;
    });
  }
}
