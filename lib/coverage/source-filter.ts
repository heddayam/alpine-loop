import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AreaGeometry } from "@/lib/data/area-geometry";
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
 * every vertex inside the routing buffer. Complete only matching objects from
 * the original source so unrelated large relations cannot expand local work.
 * Simple extraction supplies local node IDs; two parent scans recover every
 * incident way and its direct relations, even on Osmium versions whose simple
 * selector only checks the first way node or relation member. Keep node seeds
 * out of getid's reference closure to avoid duplicating its dense node ID table.
 * https://docs.osmcode.org/osmium/latest/osmium-extract.html
 * https://docs.osmcode.org/osmium/latest/osmium-tags-filter.html
 * https://docs.osmcode.org/osmium/latest/osmium-getparents.html
 * https://docs.osmcode.org/osmium/latest/osmium-getid.html
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
    // Pad the actual extent, not each merged component's bounding rectangle.
    // Otherwise an L-shaped support addition re-extracts the entire core.
    // Expanded segment boxes conservatively cover nearby building/access context.
    let envelope=geometry;
    let padding: AreaGeometry[]=[];
    const flush=()=>{if(padding.length) envelope=unionCoverage([envelope,...padding]);padding=[];};
    for(const rings of polygons) for(const ring of rings) for(let i=1;i<ring.length;i++) {
      const a=ring[i-1]!,b=ring[i]!;
      padding.push(rectangle([Math.max(-180,Math.min(a[0],b[0])-.01),Math.max(-90,Math.min(a[1],b[1])-.01),
        Math.min(180,Math.max(a[0],b[0])+.01),Math.min(90,Math.max(a[1],b[1])+.01)]));
      if(padding.length>=256) flush();
    }
    flush();
    const polygon = path.join(temporary, "context.geojson");
    await writeFile(polygon, JSON.stringify({ type: "Feature", properties: {}, geometry: envelope }));
    const partial = path.join(temporary, "partial.osm.pbf");
    const parents = path.join(temporary, "parents.osm.pbf");
    const context = path.join(temporary, "context.osm.pbf");
    const seeds = path.join(temporary, "seeds.osm.pbf");
    const references = path.join(temporary, "reference-seeds.osm.opl");
    const completed = path.join(temporary, "completed.osm.pbf");
    for await (const unused of osmium(["extract", sourceFile, "--polygon", polygon,
      "--strategy", "simple", "--output", partial], checkpoint)) void unused;
    // getparents rejects an empty ID list. Read just one object rather than
    // converting the entire local extract to text or inspecting PBF internals.
    let hasObjects = false;
    for await (const unused of osmium(["cat", partial, "--output-format", "opl"], checkpoint)) {
      void unused;
      hasObjects = true;
      break;
    }
    if (!hasObjects) return;

    // Each scan resolves one parent level: local nodes -> ways -> direct relations.
    // Do not complete unrelated relation members before filtering their tags.
    await onStage?.("Selecting local trails and context");
    for (const [selected, output] of [[partial, parents], [parents, context]]) {
      for await (const unused of osmium(["getparents", sourceFile, "--id-osm-file", selected!,
        "--add-self", "--output", output!], checkpoint)) void unused;
      await rm(selected!, { force: true });
    }

    await onStage?.("Filtering local trails and context");
    for await (const unused of osmium(["tags-filter", context, ...CONTEXT_FILTERS,
      "--omit-referenced", "--output", seeds], checkpoint)) void unused;
    await rm(context, { force: true });
    for await (const unused of osmium(["cat", seeds, "--object-type", "way", "--object-type", "relation",
      "--output-format", "opl", "--output", references], checkpoint)) void unused;
    if ((await stat(references)).size === 0) {
      yield* osmium(["cat", seeds, "--output-format", "opl"], checkpoint);
      return;
    }

    await onStage?.("Completing selected trail and context references");
    for await (const unused of osmium(["getid", sourceFile, "--id-osm-file", references,
      "--add-referenced", "--output", completed], checkpoint)) void unused;
    await rm(references, { force: true });
    // Both files contain unchanged objects from the same immutable source. Merge
    // deduplicates overlap while preserving standalone evidence nodes and order.
    yield* osmium(["merge", seeds, completed, "--output-format", "opl"], checkpoint);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
