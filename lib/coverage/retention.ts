import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withGenerationLock } from "@/lib/packs/generation-pins";
import { loadInstalledPack, loadInstalledPackVersion, localPackRoot } from "@/lib/packs/installed-pack";

const PACK_ID = "local-coverage";

export type CoverageRetention = {
  activeVersion: string;
  referencedVersions: string[];
  eligibleVersions: string[];
  deletedVersions: string[];
};

function routeJobReferences(databasePath: string): Set<string> {
  // A missing or unreadable job database is unknown history, not evidence of no references.
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const references = new Set<string>();
    for (const row of database.prepare("SELECT plan_json FROM route_jobs").iterate() as Iterable<{ plan_json: string }>) {
      const plan: unknown = JSON.parse(row.plan_json);
      if (!plan || typeof plan !== "object" || !Array.isArray((plan as { packs?: unknown }).packs)) {
        throw new Error("Route-job plan has no pinned packs");
      }
      for (const pack of (plan as { packs: unknown[] }).packs) {
        if (!pack || typeof pack !== "object" || typeof (pack as { id?: unknown }).id !== "string" ||
          typeof (pack as { dataVersion?: unknown }).dataVersion !== "string") {
          throw new Error("Route-job plan contains an invalid pack reference");
        }
        if ((pack as { id: string }).id === PACK_ID) references.add((pack as { dataVersion: string }).dataVersion);
      }
    }
    return references;
  } finally { database.close(); }
}

/** Explicit cleanup shares the generation lock with publication and plan pinning. */
export async function cleanupCoverageGenerations(options: {
  packRoot?: string;
  routeJobsDb?: string;
  deleteEligible?: boolean;
} = {}): Promise<CoverageRetention> {
  const root = options.packRoot ?? localPackRoot();
  const databasePath = options.routeJobsDb ?? process.env.ALPINE_ROUTE_JOBS_DB ??
    path.resolve(process.cwd(), ".local-data/runtime/route-jobs.sqlite");
  return withGenerationLock(root, async (lock) => {
    const active = await loadInstalledPack(PACK_ID, root);
    if (!active) throw new Error("No active local coverage generation; retention cannot identify a protected snapshot");
    const activeVersion = active.manifest.dataVersion;
    const referenced = routeJobReferences(databasePath);
    for (const version of lock.liveVersions()) referenced.add(version);
    const eligibleVersions: string[] = [];
    for (const entry of await readdir(path.join(root, PACK_ID), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === activeVersion || referenced.has(entry.name)) continue;
      try {
        const installed = await loadInstalledPackVersion(PACK_ID, entry.name, root);
        if (installed) eligibleVersions.push(entry.name);
      } catch { /* Unknown or incomplete directories are never cleanup candidates. */ }
    }
    eligibleVersions.sort();
    const deletedVersions: string[] = [];
    if (options.deleteEligible) for (const version of eligibleVersions) {
      await rm(path.join(root, PACK_ID, version), { recursive: true });
      deletedVersions.push(version);
    }
    return { activeVersion, referencedVersions: [...referenced].sort(), eligibleVersions, deletedVersions };
  });
}
