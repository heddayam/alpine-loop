import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOfficialSourceConfigs,
  readOfficialSourceSnapshots,
  type OfficialSourceSet,
} from "./source";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "regional-official-sources-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("regional official source sets", () => {
  it("loads configs and cached snapshots from a region-owned namespace", async () => {
    const root = await temporaryDirectory();
    const configRoot = path.join(root, "configs");
    const cacheRoot = path.join(root, "cache");
    const cacheNamespace = "southern-east-bay-official-access";
    const localPath = path.join(root, "source.json");
    const metadataContentHash = `sha256:${"a".repeat(64)}`;
    const inspectedSnapshotContentHash = `sha256:${createHash("sha256").update("fixture source bytes").digest("hex")}`;
    const sourceSet: OfficialSourceSet = { configRoot, filenames: ["ebrpd.json"], cacheNamespace };
    await mkdir(configRoot, { recursive: true });
    await mkdir(path.join(cacheRoot, cacheNamespace), { recursive: true });
    await writeFile(localPath, "fixture source bytes");
    await writeFile(path.join(configRoot, "ebrpd.json"), JSON.stringify({
      id: "ebrpd-trails",
      authority: "East Bay Regional Park District",
      dataset: "Trails",
      version: "fixture-v1",
      retrievedAt: "2026-08-06T00:00:00.000Z",
      downloadUrl: "https://example.com/ebrpd.json",
      license: "Fixture license",
      termsDecision: "Fixture use only",
      redistribution: "allowed",
      metadataContentHash,
      inspectedSnapshotContentHash,
    }));
    await writeFile(path.join(cacheRoot, cacheNamespace, "pinned.json"), JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: "ebrpd-trails", metadataContentHash, localPath }],
    }));

    await expect(readOfficialSourceConfigs(sourceSet)).resolves.toMatchObject([{ id: "ebrpd-trails" }]);
    await expect(readOfficialSourceSnapshots(cacheRoot, sourceSet)).resolves.toMatchObject([{
      id: "ebrpd-trails",
      contentHash: inspectedSnapshotContentHash,
      localPath,
    }]);

    await writeFile(localPath, "changed source bytes");
    await expect(readOfficialSourceSnapshots(cacheRoot, sourceSet)).rejects.toThrow(/inspected snapshot hash/);
  });

  it("rejects unsafe cache namespaces and config paths", async () => {
    const root = await temporaryDirectory();
    await expect(readOfficialSourceConfigs({
      configRoot: root,
      filenames: ["../source.json"],
      cacheNamespace: "valid-region",
    })).rejects.toThrow(/config filename/);
    await expect(readOfficialSourceConfigs({
      configRoot: root,
      filenames: ["source.json"],
      cacheNamespace: "../invalid",
    })).rejects.toThrow(/cache namespace/);
  });
});
