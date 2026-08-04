import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstalledPack } from "./installed-pack";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpine-installed-pack-"));
  temporaryRoots.push(root);
  const directory = path.join(root, "santa-cruz-mountains", "2026-08-04");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "pack.sqlite"), "fixture");
  const manifest = {
    schemaVersion: "1",
    id: "santa-cruz-mountains",
    name: "Santa Cruz Mountains",
    dataVersion: "2026-08-04",
    builtAt: "2026-08-04T00:00:00Z",
    compilerVersion: "test",
    metricAlgorithmVersion: "test",
    coverage: {
      bbox: [-122.55, 36.95, -121.75, 37.55],
      boundary: { type: "Polygon", coordinates: [[[-122.55, 36.95], [-121.75, 36.95], [-121.75, 37.55], [-122.55, 37.55], [-122.55, 36.95]]] },
    },
    display: { center: [-122.15, 37.25], zoom: 9 },
    capabilities: { elevation: true, officialAccess: true },
    fieldConfidence: { topology: "high", elevation: "high", access: "medium" },
    sources: [{
      id: "source",
      authority: "Authority",
      dataset: "Dataset",
      version: "1",
      retrievedAt: "2026-08-04T00:00:00Z",
      url: "https://example.com/source",
      license: "Test license",
      contentHash: `sha256:${"a".repeat(64)}`,
    }],
  };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "santa-cruz-mountains", "current.json"), JSON.stringify({
    dataVersion: "2026-08-04",
    path: "2026-08-04/manifest.json",
  }));
  return root;
}

describe("installed pack discovery", () => {
  it("returns null when the pack has not been built", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "alpine-installed-pack-"));
    temporaryRoots.push(root);
    await expect(loadInstalledPack("santa-cruz-mountains", root)).resolves.toBeNull();
  });

  it("validates the current pointer, manifest, and readable database", async () => {
    const root = await packRoot();
    const installed = await loadInstalledPack("santa-cruz-mountains", root);
    expect(installed?.manifest.name).toBe("Santa Cruz Mountains");
    expect(installed?.databasePath).toBe(path.join(root, "santa-cruz-mountains", "2026-08-04", "pack.sqlite"));
  });

  it("rejects a current pointer that escapes its pack directory", async () => {
    const root = await packRoot();
    await writeFile(path.join(root, "santa-cruz-mountains", "current.json"), JSON.stringify({
      dataVersion: "2026-08-04",
      path: "../outside/manifest.json",
    }));
    await expect(loadInstalledPack("santa-cruz-mountains", root)).rejects.toThrow("leaves the configured pack root");
  });
});
