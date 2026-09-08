import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compilePack } from "@/lib/data/compiler";
import { fixtureCompileOptions, fixturePackSeed } from "@/lib/data/fixture-pack";
import { listManagedPacks, removeManagedPacks } from "./management";

const pack = "santa-cruz-mountains";
let root: string;
let catalog: string;
let jobs: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "alpine-pack-management-"));
  catalog = path.join(root, "packs");
  jobs = path.join(root, "jobs.sqlite");
  await mkdir(path.join(catalog, pack), { recursive: true });
  await writeFile(path.join(catalog, pack, "retained-until-removal"), "pack data");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function createJobs(status: string, options: { legacy?: boolean; filename?: string; id?: string; malformed?: boolean } = {}) {
  const database = new DatabaseSync(options.filename ?? jobs);
  const field = options.legacy ? "pack_id" : "plan_json";
  database.exec(`CREATE TABLE route_jobs (id TEXT, status TEXT, ${field} TEXT)`);
  const value = options.legacy ? options.id ?? pack : options.malformed ? "{}" : JSON.stringify({ packs: [{ id: options.id ?? pack }] });
  database.prepare(`INSERT INTO route_jobs VALUES (?, ?, ?)`).run("saved-search", status, value);
  database.close();
}

describe("pack selector metadata", () => {
  it("lists only buildable regions and exposes validated installations", async () => {
    await compilePack(await fixtureCompileOptions(catalog, undefined, undefined, undefined, {
      seed: { ...fixturePackSeed, id: pack },
      searchRegions: { version: 1, regions: [{ namedAreaId: `pack:${pack}`, expectedName: fixturePackSeed.name }] },
    }));
    const packs = await listManagedPacks(catalog);
    expect(packs.map(({ id }) => id)).toEqual([
      pack, "southern-east-bay", "monterey-carmel", "henry-coe", "central-cascades",
    ]);
    expect(packs[0]).toMatchObject({ id: pack, label: "Santa Cruz Mountains", installed: true });
    expect(packs[0]!.size).toMatch(/^\d+\.\d MB installed$/);
    expect(packs[4]).toMatchObject({ installed: false, size: "~2.24 GB download · ~404 MB finished" });
  });

  it("explains an invalid installation instead of presenting it as absent", async () => {
    await writeFile(path.join(catalog, pack, "current.json"), "broken");
    await expect(listManagedPacks(catalog)).rejects.toThrow(/Cannot inspect Santa Cruz Mountains.*Rebuild with docker compose/);
  });
});

describe("pack removal", () => {
  it.each(["queued", "resolving", "resolving-drive-time", "running", "deleting"])("blocks a %s search without modifying its database or packs", async (status) => {
    createJobs(status);
    const original = await readFile(jobs);
    await expect(removeManagedPacks([pack], catalog, [jobs])).rejects.toThrow(/unfinished search saved-search/);
    expect(await readFile(jobs)).toEqual(original);
    expect((await stat(path.join(catalog, pack))).isDirectory()).toBe(true);
  });

  it("protects legacy jobs without migrating the database", async () => {
    createJobs("running", { legacy: true });
    const original = await readFile(jobs);
    await expect(removeManagedPacks([pack], catalog, [jobs])).rejects.toThrow(/unfinished search/);
    expect(await readFile(jobs)).toEqual(original);
  });

  it("checks the native database even when the Docker database is safe", async () => {
    createJobs("completed");
    const nativeJobs = path.join(root, "native-jobs.sqlite");
    createJobs("queued", { filename: nativeJobs });
    await expect(removeManagedPacks([pack], catalog, [jobs, nativeJobs])).rejects.toThrow(/unfinished search/);
  });

  it.each(["completed", "cancelled", "failed"])("preserves %s searches, source caches, and other packs", async (status) => {
    createJobs(status);
    const original = await readFile(jobs);
    await writeFile(path.join(root, "source-cache"), "cached source");
    await mkdir(path.join(catalog, "central-cascades"));
    await removeManagedPacks([pack], catalog, [jobs]);
    await expect(stat(path.join(catalog, pack))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(jobs)).toEqual(original);
    expect(await readFile(path.join(root, "source-cache"), "utf8")).toBe("cached source");
    expect((await stat(path.join(catalog, "central-cascades"))).isDirectory()).toBe(true);
  });

  it("allows unfinished work in a different region and an absent database", async () => {
    createJobs("running", { id: "central-cascades" });
    await removeManagedPacks([pack], catalog, [path.join(root, "absent.sqlite"), jobs]);
    await expect(stat(path.join(catalog, pack))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, "absent.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../outside", "/tmp", "marin-mount-tam", "unknown", ""])("validates every ID before removing anything (%s)", async (invalid) => {
    await expect(removeManagedPacks([pack, invalid], catalog, [])).rejects.toThrow("Unknown pack");
    expect((await stat(path.join(catalog, pack))).isDirectory()).toBe(true);
  });

  it("refuses symbolic pack directories and preserves their targets", async () => {
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(catalog, "central-cascades"));
    await expect(removeManagedPacks([pack, "central-cascades"], catalog, [])).rejects.toThrow(/symbolic link/);
    expect((await stat(path.join(root, "outside"))).isDirectory()).toBe(true);
    expect((await stat(path.join(catalog, pack))).isDirectory()).toBe(true);
  });

  it.each(["malformed plan", "unknown status", "unsupported schema", "corrupt database"])("fails closed on %s", async (problem) => {
    if (problem === "corrupt database") await writeFile(jobs, "not sqlite");
    else if (problem === "unsupported schema") {
      const database = new DatabaseSync(jobs);
      database.exec("CREATE TABLE unrelated (id TEXT)");
      database.close();
    } else createJobs(problem === "unknown status" ? "mystery" : "running", { malformed: problem === "malformed plan" });
    await expect(removeManagedPacks([pack], catalog, [jobs])).rejects.toThrow(/Cannot remove packs/);
    expect((await stat(path.join(catalog, pack))).isDirectory()).toBe(true);
  });
});
