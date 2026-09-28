import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { areaGeometryBounds, type AreaGeometry } from "@/lib/data/area-geometry";
import { rectangle, unionCoverage } from "./geometry";

const CONTEXT_FILTERS = [
  "w/highway", "w/footway", "nw/amenity=parking", "nw/highway=trailhead",
  "nw/information=trailhead,guidepost,board,map", "nw/tourism=information",
  "nw/barrier=gate", "nwr/building",
];

/** One owned child, including cancellation during native scans and early iterator return. */
async function* osmium(args: string[], checkpoint: () => Promise<void>): AsyncGenerator<string> {
  await checkpoint();
  const child = spawn("osmium", args, { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false, stderr = "", failure: unknown;
  const done = new Promise<void>((resolve) => {
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, signal) => {
      closed = true;
      if (code !== 0) failure ??= new Error(`osmium ${args[0]} failed (${signal ?? code}): ${stderr.trim()}`);
      resolve();
    });
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> = Promise.resolve();
  const heartbeat = () => {
    timer = setTimeout(() => {
      checking = checkpoint().catch((error: unknown) => {
        failure ??= error;
        if (!closed) child.kill("SIGKILL");
      }).then(() => { if (!closed && !failure) heartbeat(); });
    }, 1000);
  };
  heartbeat();
  try {
    // Readable iteration applies backpressure while the consumer commits its batch.
    // setEncoding also preserves UTF-8 names spanning native stdout chunks.
    child.stdout.setEncoding("utf8");
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += chunk as string;
      let start = 0, end: number;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        if (failure) throw failure;
        yield pending.slice(start, end);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    await done;
    await checking;
    if (failure) throw failure;
    if (pending) yield pending;
  } finally {
    if (timer) clearTimeout(timer);
    if (!closed) child.kill("SIGKILL");
    await done;
    await checking;
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stream only relevant OSM objects, preserving source ordering and references.
 * Buffered local envelopes preserve nearby access/building context.
 * Osmium extract selects ways with a node inside: context-only segments crossing
 * the entire buffer with both endpoints outside, and enclosing polygons without
 * an inside vertex, can be absent. A closed route within the distance budget has
 * every vertex inside the routing buffer; complete ways preserve its references.
 * https://docs.osmcode.org/osmium/latest/osmium-extract.html
 * https://docs.osmcode.org/osmium/latest/osmium-tags-filter.html
 */
export async function* filteredSourceLines(
  sourceFile: string,
  workRoot: string,
  geometry: AreaGeometry,
  checkpoint: () => Promise<void>,
  onStage?: (stage: string) => Promise<void>,
): AsyncGenerator<string> {
  await mkdir(workRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(workRoot, ".osm-filter-"));
  try {
    await onStage?.("Extracting local trails and context");
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const envelope = unionCoverage(polygons.map((coordinates) => {
      const [west, south, east, north] = areaGeometryBounds({ type: "Polygon", coordinates });
      return rectangle([Math.max(-180, west - .01), Math.max(-90, south - .01), Math.min(180, east + .01), Math.min(90, north + .01)]);
    }));
    const polygon = path.join(temporary, "context.geojson");
    await writeFile(polygon, JSON.stringify({ type: "Feature", properties: {}, geometry: envelope }));
    const input = path.join(temporary, "context.osm.pbf");
    // Complete building relations only; unrelated regional boundaries can be enormous.
    for await (const unused of osmium(["extract", sourceFile, "--polygon", polygon,
      "--strategy", "smart", "-S", "types=multipolygon", "-S", "tags=building", "--output", input], checkpoint)) void unused;

    await onStage?.("Filtering local trails and context");
    yield* osmium(["tags-filter", input, ...CONTEXT_FILTERS, "--output-format", "opl"], checkpoint);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
