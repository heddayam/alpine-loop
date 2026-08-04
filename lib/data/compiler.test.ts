import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packManifestV1Schema } from "@/lib/contracts";
import { compilePack } from "./compiler";
import { fixtureCompileOptions, fixturePackSeed } from "./fixture-pack";

const temporaryDirectories: string[] = [];

async function temporaryOutput(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-pack-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixture pack compiler", () => {
  it("writes a validated manifest, audit, runtime tables, indexes, and records", async () => {
    const outputRoot = await temporaryOutput();
    const result = await compilePack(await fixtureCompileOptions(outputRoot));
    const manifest = packManifestV1Schema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
    const current = JSON.parse(await readFile(path.join(outputRoot, "fixture-pack", "current.json"), "utf8")) as {
      dataVersion: string;
    };

    expect(result.reusedExisting).toBe(false);
    expect(manifest).toMatchObject({
      id: "fixture-pack",
      dataVersion: "fixture-v1",
      metricAlgorithmVersion: "nearest-fixture-v1+metrics-v1",
      capabilities: { elevation: true, officialAccess: true },
    });
    expect(manifest.sources).toHaveLength(3);
    expect(current.dataVersion).toBe("fixture-v1");
    expect(result.audit).toMatchObject({
      nodeCount: 7,
      directedEdgeCount: 17,
      accessPointCount: 2,
      sourceCount: 3,
      rejectedWayCount: 1,
      conflictCount: 0,
      missingElevationNodeCount: 0,
      missingElevationEdgeCount: 0,
      accessStateCounts: { public: 15, unknown: 2, private: 0, closed: 0, prohibited: 0 },
    });

    const database = new DatabaseSync(result.databasePath, { readOnly: true });
    try {
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      ).all().map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining([
        "nodes", "node_spatial", "edges", "edge_spatial", "access_points",
        "sources", "metadata", "schema_migrations",
      ]));
      expect(database.prepare("SELECT count(*) AS count FROM nodes").get()).toEqual({ count: 7 });
      expect(database.prepare("SELECT count(*) AS count FROM edges").get()).toEqual({ count: 17 });
      expect(database.prepare("SELECT count(*) AS count FROM node_spatial").get()).toEqual({ count: 7 });
      expect(database.prepare("SELECT count(*) AS count FROM edge_spatial").get()).toEqual({ count: 17 });
      expect(database.prepare("SELECT access_state FROM edges WHERE id = 'w-ridge:0:forward'").get())
        .toEqual({ access_state: "public" });
      const forward = database.prepare(
        "SELECT gain_m, loss_m FROM edges WHERE id = 'w-ridge:0:forward'",
      ).get() as { gain_m: number; loss_m: number };
      const reverse = database.prepare(
        "SELECT gain_m, loss_m FROM edges WHERE id = 'w-ridge:0:reverse'",
      ).get() as { gain_m: number; loss_m: number };
      expect(forward.gain_m).toBe(reverse.loss_m);
      expect(forward.loss_m).toBe(reverse.gain_m);
    } finally {
      database.close();
    }

    const resumed = await compilePack(await fixtureCompileOptions(outputRoot));
    expect(resumed.reusedExisting).toBe(true);
    expect(resumed.packDirectory).toBe(result.packDirectory);
  });

  it("does not replace the current valid pack when a later build fails", async () => {
    const outputRoot = await temporaryOutput();
    await compilePack(await fixtureCompileOptions(outputRoot));
    const pointerPath = path.join(outputRoot, "fixture-pack", "current.json");
    const originalPointer = await readFile(pointerPath, "utf8");
    const failingOptions = await fixtureCompileOptions(outputRoot, undefined, {
      seed: { ...fixturePackSeed, dataVersion: "fixture-v2" },
      builtAt: "2026-08-04T01:00:00Z",
      beforePublish: () => { throw new Error("injected failure"); },
    });

    await expect(compilePack(failingOptions)).rejects.toThrow("injected failure");
    expect(await readFile(pointerPath, "utf8")).toBe(originalPointer);
    await expect(readFile(path.join(outputRoot, "fixture-pack", "fixture-v2", "manifest.json"), "utf8"))
      .rejects.toThrow();
  });
});
