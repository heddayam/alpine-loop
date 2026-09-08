import { lstat, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import registryJson from "@/data/regions/registry.json";
import packSizes from "@/data/regions/pack-sizes.json";
import { regionRegistryV1Schema } from "@/lib/contracts";
import { listRegionalPackBuilderIds } from "@/lib/data/regional-pack";
import { loadInstalledPack, localPackRoot } from "./installed-pack";

const builders = new Set(listRegionalPackBuilderIds());
const regions = regionRegistryV1Schema.parse(registryJson).regions
  .filter((region) => region.packId && builders.has(region.packId))
  .sort((left, right) => left.displayOrder - right.displayOrder);
const sizes: Record<string, { downloadBytes: number; finishedBytes: number }> = packSizes;
const jobPacks = z.object({ packs: z.array(z.object({ id: z.string().min(1) })).min(1) });

export async function listManagedPacks(root = localPackRoot()) {
  return Promise.all(regions.map(async (region) => {
    const id = region.packId!;
    try {
      const installed = await loadInstalledPack(id, root);
      const estimate = sizes[id];
      if (!estimate) throw new Error("Missing pack size metadata");
      let size = `~${(estimate.downloadBytes / 1e9).toFixed(2)} GB download · ~${Math.round(estimate.finishedBytes / 1e6)} MB finished`;
      if (installed) {
        const files = await readdir(installed.directory, { recursive: true, withFileTypes: true });
        const bytes = await Promise.all(files.filter((file) => file.isFile()).map(async (file) => (await stat(path.join(file.parentPath, file.name))).size));
        size = `${(bytes.reduce((sum, value) => sum + value, 0) / 1e6).toFixed(1)} MB installed`;
      }
      return { id, label: region.label, installed: Boolean(installed), size };
    } catch (error) {
      throw new Error(`Cannot inspect ${region.label}: ${(error as Error).message}. Rebuild with docker compose run --rm packs scripts/pack-bootstrap.ts --pack=${id} --progress.`);
    }
  }));
}

function defaultJobPaths(): string[] {
  return [...new Set([
    process.env.ALPINE_ROUTE_JOBS_DB ?? ".local-data/runtime/route-jobs.sqlite",
    process.env.ALPINE_NATIVE_ROUTE_JOBS_DB ?? ".local-data/runtime/route-jobs.sqlite",
  ])];
}

async function checkJobs(filename: string, removed: Set<string>): Promise<void> {
  try { await stat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    const columns = database.prepare("PRAGMA table_info(route_jobs)").all().map(({ name }) => name);
    const field = columns.includes("plan_json") ? "plan_json" : "pack_id";
    if (!["id", "status", field].every((name) => columns.includes(name))) {
      throw new Error("Unsupported route-job schema");
    }
    for (const row of database.prepare(`SELECT id, status, ${field} FROM route_jobs`).all()) {
      if (["completed", "cancelled", "failed"].includes(String(row.status))) continue;
      if (!["queued", "resolving", "resolving-drive-time", "running", "deleting"].includes(String(row.status))) {
        throw new Error(`Unknown status for search ${row.id}`);
      }
      const ids = field === "plan_json"
        ? jobPacks.parse(JSON.parse(String(row.plan_json))).packs.map(({ id }) => id)
        : [z.string().min(1).parse(row.pack_id)];
      const blocked = ids.find((id) => removed.has(id));
      if (blocked) throw new Error(`${blocked} is needed by unfinished search ${row.id}; cancel or finish it in the app first`);
    }
  } catch (error) {
    throw new Error(`Cannot remove packs: ${(error as Error).message} (${filename})`);
  } finally { database?.close(); }
}

/** Caller stops the application before inspection so no new search can race removal. */
export async function removeManagedPacks(ids: string[], root = localPackRoot(), jobPaths = defaultJobPaths()): Promise<void> {
  const selected = new Set(ids);
  if (!selected.size) throw new Error("Select at least one pack to remove");
  for (const id of selected) {
    if (!regions.some((region) => region.packId === id)) throw new Error(`Unknown pack: ${id}`);
    try {
      if (!(await lstat(path.join(root, id))).isDirectory()) {
        throw new Error(`Cannot remove ${id}: expected a pack directory, not a file or symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const filename of new Set(jobPaths)) await checkJobs(filename, selected);
  for (const id of selected) await rm(path.join(root, id), { recursive: true, force: true });
}
