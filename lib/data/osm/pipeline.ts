import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot, TopologySourceAdapter } from "../adapters";
import { sha256File } from "../file-source";
import { withAtomicDirectory } from "../source-cache";
import type { NormalizedTopology } from "../types";
import { requireCommand, runCommand, type CommandRunner } from "./command";
import { readAndNormalizeOsmOpl } from "./opl";

const boundarySchema = z.object({
  type: z.literal("Feature"),
  properties: z.record(z.string(), z.unknown()).optional(),
  geometry: z.object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number().finite(), z.number().finite()])).min(4)).min(1),
  }).strict(),
}).strict();

export type OsmPipelineOptions = {
  boundaryPath: string;
  preparationRoot: string;
  runner?: CommandRunner;
};

const ADAPTER_VERSION = "osmium-complete-ways-hiking-v1";
const HIGHWAY_FILTER = "w/highway=path,footway,track,pedestrian,steps,bridleway,service,unclassified,residential,living_street";

async function nonempty(filePath: string, label: string): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) throw new Error(`${label} was empty`);
}

async function readPrepared(filePath: string): Promise<NormalizedTopology | null> {
  try {
    await access(filePath, constants.R_OK);
    const value = JSON.parse(await readFile(filePath, "utf8")) as NormalizedTopology;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.ways) || value.ways.length === 0) return null;
    return value;
  } catch {
    return null;
  }
}

export async function validateOsmPrerequisites(runner: CommandRunner = runCommand): Promise<string> {
  return requireCommand("osmium", runner);
}

export async function prepareOsmTopology(
  snapshot: SourceSnapshot,
  options: OsmPipelineOptions,
): Promise<NormalizedTopology> {
  if (!snapshot.license.trim()) throw new Error(`Source ${snapshot.id} has no license decision`);
  const actualHash = await sha256File(snapshot.localPath);
  if (actualHash !== snapshot.contentHash) throw new Error(`Content hash mismatch for source ${snapshot.id}`);
  boundarySchema.parse(JSON.parse(await readFile(options.boundaryPath, "utf8")));
  await validateOsmPrerequisites(options.runner);
  const boundaryHash = await sha256File(options.boundaryPath);
  const key = `${actualHash.slice(7, 23)}-${boundaryHash.slice(7, 23)}-${ADAPTER_VERSION}`;
  const destination = path.join(options.preparationRoot, key);
  const normalizedPath = path.join(destination, "topology.json");
  const prepared = await readPrepared(normalizedPath);
  if (prepared) return prepared;

  let result: NormalizedTopology | null = null;
  await withAtomicDirectory(destination, async (staging) => {
    const extracted = path.join(staging, "region.osm.pbf");
    const filtered = path.join(staging, "hiking.osm.pbf");
    const opl = path.join(staging, "hiking.opl");
    const runner = options.runner ?? runCommand;
    await runner("osmium", [
      "extract", "--polygon", options.boundaryPath, "--strategy", "complete_ways",
      "--set-bounds", "--overwrite", "--output", extracted, snapshot.localPath,
    ]);
    await nonempty(extracted, "OSM polygon extraction");
    await runner("osmium", [
      "tags-filter", extracted, HIGHWAY_FILTER, "n/highway=trailhead", "n/amenity=parking",
      "r/route=hiking,foot", "--overwrite", "--output", filtered,
    ]);
    await nonempty(filtered, "OSM hiking filter");
    await runner("osmium", [
      "cat", filtered, "--output-format", "opl", "--overwrite", "--output", opl,
    ]);
    await nonempty(opl, "OSM OPL export");
    result = await readAndNormalizeOsmOpl(opl, snapshot.id);
    await writeFile(path.join(staging, "topology.json"), `${JSON.stringify(result)}\n`, { flag: "wx" });
  });
  if (!result) throw new Error("OSM preparation did not produce topology");
  return result;
}

export class OsmPbfTopologyAdapter implements TopologySourceAdapter<NormalizedTopology> {
  readonly adapterVersion = ADAPTER_VERSION;

  constructor(private readonly options: OsmPipelineOptions) {}

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await prepareOsmTopology(snapshot, this.options);
  }

  async *normalize(snapshot: SourceSnapshot): AsyncIterable<NormalizedTopology> {
    yield await prepareOsmTopology(snapshot, this.options);
  }
}
