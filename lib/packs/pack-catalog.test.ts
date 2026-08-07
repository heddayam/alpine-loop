import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_BUILDER_PACK } from "./fixture-pack";
import { loadInstalledPack } from "./installed-pack";
import { loadBuilderPack } from "./builder-pack";
import { loadPackCatalog } from "./pack-catalog";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpine-pack-catalog-"));
  temporaryRoots.push(root);
  return root;
}

async function installSantaCruz(root: string): Promise<void> {
  const directory = path.join(root, "santa-cruz-mountains", "scm-test");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "pack.sqlite"), "fixture");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: "1",
    id: "santa-cruz-mountains",
    name: "Santa Cruz Mountains",
    dataVersion: "scm-test",
    builtAt: "2026-08-06T00:00:00Z",
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
      id: "source", authority: "Authority", dataset: "Dataset", version: "1",
      retrievedAt: "2026-08-06T00:00:00Z", url: "https://example.com/source", license: "Test",
      contentHash: `sha256:${"a".repeat(64)}`,
    }],
  }));
  await writeFile(path.join(root, "santa-cruz-mountains", "current.json"), JSON.stringify({
    dataVersion: "scm-test",
    path: "scm-test/manifest.json",
  }));
}

describe("catalog-linked pack discovery", () => {
  it("returns every configured region in display order with planned and unavailable states", async () => {
    const catalog = await loadPackCatalog(await emptyRoot());
    expect(catalog.regions.map(({ id }) => id)).toEqual([
      "santa-cruz-mountains",
      "southern-east-bay",
      "monterey-carmel",
      "henry-coe",
      "marin-mount-tam",
      "tahoe-eldorado",
    ]);
    expect(catalog.regions.map(({ state }) => state)).toEqual([
      "unavailable", "unavailable", "planned", "planned", "planned", "planned",
    ]);
  });

  it("exposes metadata only for a valid linked installation", async () => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    const catalog = await loadPackCatalog(root);
    expect(catalog.regions[0]).toMatchObject({
      state: "available",
      packId: "santa-cruz-mountains",
      pack: { id: "santa-cruz-mountains", dataVersion: "scm-test" },
    });
    expect(catalog.regions[1]).not.toHaveProperty("pack");
  });

  it("downgrades invalid linked installations without weakening direct-load validation", async () => {
    const root = await emptyRoot();
    await mkdir(path.join(root, "santa-cruz-mountains"), { recursive: true });
    await writeFile(path.join(root, "santa-cruz-mountains", "current.json"), "not json");
    const catalog = await loadPackCatalog(root);
    expect(catalog.regions[0]).toMatchObject({ id: "santa-cruz-mountains", state: "unavailable" });
    await expect(loadInstalledPack("santa-cruz-mountains", root)).rejects.toThrow();
  });

  it("selects a requested available builder pack, falls back to the first available pack, then the fixture", async () => {
    const root = await emptyRoot();
    await expect(loadBuilderPack("missing-pack", root)).resolves.toBe(FIXTURE_BUILDER_PACK);
    await installSantaCruz(root);
    await expect(loadBuilderPack("santa-cruz-mountains", root)).resolves.toMatchObject({ id: "santa-cruz-mountains" });
    await expect(loadBuilderPack("missing-pack", root)).resolves.toMatchObject({ id: "santa-cruz-mountains" });
  });
});
