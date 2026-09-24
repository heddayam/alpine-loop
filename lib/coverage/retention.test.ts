import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { fixturePackSeed } from "@/lib/data/fixture-pack";
import { withGenerationLock, withGenerationPins } from "@/lib/packs/generation-pins";
import { cleanupCoverageGenerations } from "./retention";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(versions: string[], referenced: string[] = []): Promise<{ packRoot: string; routeJobsDb: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpine-retention-"));
  roots.push(root);
  const packRoot = path.join(root, "packs");
  for (const version of versions) {
    const directory = path.join(packRoot, "local-coverage", version);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "pack.sqlite"), "fixture");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      ...fixturePackSeed, id: "local-coverage", dataVersion: version,
      builtAt: "2026-09-24T00:00:00Z", metricAlgorithmVersion: "test",
      sources: [{ id: "test", authority: "test", dataset: "test", version: "1",
        retrievedAt: "2026-09-24T00:00:00Z", url: "https://example.com", license: "test",
        contentHash: `sha256:${"a".repeat(64)}` }],
    }));
  }
  await writeFile(path.join(packRoot, "local-coverage", "current.json"), JSON.stringify({
    dataVersion: versions.at(-1), path: `${versions.at(-1)}/manifest.json`,
  }));
  const routeJobsDb = path.join(root, "route-jobs.sqlite");
  const database = new DatabaseSync(routeJobsDb);
  database.exec("CREATE TABLE route_jobs (id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, status TEXT NOT NULL)");
  for (const [index, version] of referenced.entries()) {
    database.prepare("INSERT INTO route_jobs VALUES (?,?,?)").run(String(index),
      JSON.stringify({ packs: [{ id: "local-coverage", dataVersion: version, builtAt: "2026-09-24T00:00:00Z" }] }),
      index ? "running" : "completed");
  }
  database.close();
  return { packRoot, routeJobsDb };
}

it("previews unused generations without deleting them", async () => {
  const options = await setup(["old", "active"]);
  const result = await cleanupCoverageGenerations(options);
  expect(result).toEqual({ activeVersion: "active", referencedVersions: [], eligibleVersions: ["old"], deletedVersions: [] });
  expect(existsSync(path.join(options.packRoot, "local-coverage", "old"))).toBe(true);
});

it("lists only unpinned generations while keeping active and all saved or running job pins", async () => {
  const options = await setup(["unused", "saved", "running", "active"], ["saved", "running"]);
  const result = await cleanupCoverageGenerations(options);
  expect(result.eligibleVersions).toEqual(["unused"]);
  const removed = await cleanupCoverageGenerations({ ...options, deleteEligible: true });
  expect(removed.deletedVersions).toEqual(["unused"]);
  for (const version of ["saved", "running", "active"]) {
    expect(existsSync(path.join(options.packRoot, "local-coverage", version))).toBe(true);
  }
  expect(existsSync(path.join(options.packRoot, "local-coverage", "unused"))).toBe(false);
});

it("fails closed when route-job history is unavailable or corrupt", async () => {
  const options = await setup(["old", "active"]);
  await expect(cleanupCoverageGenerations({ ...options, routeJobsDb: path.join(options.packRoot, "missing.sqlite"), deleteEligible: true })).rejects.toThrow();
  const database = new DatabaseSync(options.routeJobsDb);
  database.prepare("INSERT INTO route_jobs VALUES (?,?,?)").run("bad", "{}", "completed");
  database.close();
  await expect(cleanupCoverageGenerations({ ...options, deleteEligible: true })).rejects.toThrow("no pinned packs");
  expect(existsSync(path.join(options.packRoot, "local-coverage", "old"))).toBe(true);
});

it("keeps a generation pinned by an active quick search until the search finishes", async () => {
  const options = await setup(["old", "active"]);
  await withGenerationPins(options.packRoot, ["old"], async () => {
    const during = await cleanupCoverageGenerations({ ...options, deleteEligible: true });
    expect(during.deletedVersions).toEqual([]);
    expect(existsSync(path.join(options.packRoot, "local-coverage", "old"))).toBe(true);
  });
  const after = await cleanupCoverageGenerations({ ...options, deleteEligible: true });
  expect(after.deletedVersions).toEqual(["old"]);
});

it("serializes saved-job creation with cleanup so its new plan protects the generation", async () => {
  const options = await setup(["old", "active"]);
  const creation = withGenerationLock(options.packRoot, async (lock) => {
    await lock.requireVersions(["old"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const database = new DatabaseSync(options.routeJobsDb);
    database.prepare("INSERT INTO route_jobs VALUES (?,?,?)").run("new-job",
      JSON.stringify({ packs: [{ id: "local-coverage", dataVersion: "old" }] }), "queued");
    database.close();
  });
  const cleanup = cleanupCoverageGenerations({ ...options, deleteEligible: true });
  await creation;
  expect((await cleanup).deletedVersions).toEqual([]);
  expect(existsSync(path.join(options.packRoot, "local-coverage", "old"))).toBe(true);
});
