import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceSnapshot } from "../adapters";
import { withAtomicDirectory } from "../source-cache";
import { runCommand } from "./command";
import { preparedOsmRegionPath, type OsmPipelineOptions } from "./pipeline";

/**
 * Building centroids, used to tell a trailhead apart from a street corner.
 *
 * Buildings are the most direct evidence that people live somewhere, and they
 * come out of the OSM extract we already download. The immediate surroundings
 * are what "is this in a neighbourhood" asks about, so this is deliberately a
 * local measurement rather than a wide-area one.
 *
 * Only centroids are kept. Footprint geometry would be far larger and nothing
 * downstream needs the shape.
 */
export const BUILDINGS_ADAPTER_VERSION = "osmium-buildings-v1";

export type BuildingCentroid = readonly [lon: number, lat: number];

function centroidOf(geometry: unknown): BuildingCentroid | null {
  if (typeof geometry !== "object" || geometry === null) return null;
  const shape = geometry as { type?: unknown; coordinates?: unknown };
  const ring = shape.type === "Point"
    ? [shape.coordinates]
    : shape.type === "Polygon"
      ? (shape.coordinates as unknown[])[0]
      : shape.type === "LineString"
        ? shape.coordinates
        : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let lon = 0;
  let lat = 0;
  let counted = 0;
  for (const entry of ring) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [x, y] = entry as number[];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    lon += x;
    lat += y;
    counted += 1;
  }
  if (counted === 0) return null;
  // Five decimal places is about a metre, far finer than a 500 m count needs,
  // and it keeps the retained centroid file about 40% smaller.
  return [round5(lon / counted), round5(lat / counted)];
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

export function parseBuildingCentroids(geojsonSeq: string): BuildingCentroid[] {
  const centroids: BuildingCentroid[] = [];
  // osmium's geojsonseq output separates records with RS (U+001E).
  for (const record of geojsonSeq.split("\u001E")) {
    const line = record.trim();
    if (line.length === 0) continue;
    const feature = JSON.parse(line) as { geometry?: unknown };
    const centroid = centroidOf(feature.geometry);
    if (centroid) centroids.push(centroid);
  }
  return centroids;
}

async function nonempty(filePath: string, label: string): Promise<void> {
  const stats = await stat(filePath).catch(() => null);
  if (!stats || stats.size === 0) throw new Error(`${label} produced no output`);
}

async function readPreparedBuildings(filePath: string): Promise<BuildingCentroid[] | null> {
  const contents = await readFile(filePath, "utf8").catch(() => null);
  return contents === null ? null : JSON.parse(contents) as BuildingCentroid[];
}

export async function prepareOsmBuildings(
  snapshot: SourceSnapshot,
  options: OsmPipelineOptions,
): Promise<BuildingCentroid[]> {
  const regionPath = await preparedOsmRegionPath(snapshot, options);
  const destination = path.join(
    options.preparationRoot,
    "buildings",
    `${snapshot.contentHash.slice(7, 23)}-${BUILDINGS_ADAPTER_VERSION}`,
  );
  const normalizedPath = path.join(destination, "buildings.json");
  const prepared = await readPreparedBuildings(normalizedPath);
  if (prepared) return prepared;

  let result: BuildingCentroid[] | null = null;
  await withAtomicDirectory(destination, async (staging) => {
    const filtered = path.join(staging, "buildings.osm.pbf");
    const exported = path.join(staging, "buildings.geojsonseq");
    const runner = options.runner ?? runCommand;
    await runner("osmium", ["tags-filter", regionPath, "wa/building", "--overwrite", "--output", filtered]);
    await nonempty(filtered, "OSM building filter");
    await runner("osmium", [
      "export", filtered, "--output-format=geojsonseq", "--overwrite", "--output", exported,
    ]);
    await nonempty(exported, "OSM building export");
    result = parseBuildingCentroids(await readFile(exported, "utf8"));
    if (result.length === 0) throw new Error("OSM building extraction produced no buildings");
    await writeFile(path.join(staging, "buildings.json"), `${JSON.stringify(result)}\n`, { flag: "wx" });
    // The staging directory is renamed into place, so anything left here is
    // kept forever. The export is an order of magnitude larger than the
    // centroids it produced and is never read again.
    await Promise.all([rm(filtered, { force: true }), rm(exported, { force: true })]);
  });
  if (!result) throw new Error("OSM building preparation did not produce buildings");
  return result;
}
