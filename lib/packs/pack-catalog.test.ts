import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstalledPack } from "./installed-pack";
import { discoverCatalogPacks, legacyRoutingNeedsReview } from "./pack-catalog";

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

async function installPack(root: string, id: string, dataVersion: string, boundary: { type: "Polygon" | "MultiPolygon"; coordinates: unknown }): Promise<void> {
  const directory = path.join(root, id, dataVersion);
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, "pack.sqlite"));
  database.exec("CREATE TABLE edges (id TEXT PRIMARY KEY, source_refs TEXT NOT NULL, flags TEXT NOT NULL)");
  database.prepare("INSERT INTO edges VALUES(?,?,?)").run("osm-way-1:0:forward", '["source"]', '["osm-feature:way/1"]');
  database.close();
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: "6",
    id,
    name: id,
    dataVersion,
    builtAt: "2026-08-06T00:00:00Z",
    compilerVersion: "test",
    metricAlgorithmVersion: "test",
    coverage: {
      bbox: [-122.55, 36.95, -121.75, 37.55],
      boundary,
    },
    display: { center: [-122.15, 37.25], zoom: 9 },
    capabilities: { elevation: true, officialAccess: true, namedAreas: true, closedRouteTopology: true, batchSearchRegions: true, elevationProfiles: true, portalAccessPoints: true },
    closedRouteTopology: { runtimeMode: "reachable-graph-fallback", algorithmVersion: "test", policyVersion: "test", profiles: ["known", "inclusive"] },
    fieldConfidence: { topology: "high", elevation: "high", access: "medium" },
    sources: [{
      id: "source", authority: "Authority", dataset: "Dataset", version: "1",
      retrievedAt: "2026-08-06T00:00:00Z", url: "https://example.com/source", license: "Test",
      contentHash: `sha256:${"a".repeat(64)}`,
    }],
  }));
  await writeFile(path.join(root, id, "current.json"), JSON.stringify({
    dataVersion,
    path: `${dataVersion}/manifest.json`,
  }));
}

const santaCruz = { type: "Polygon" as const, coordinates: [[[-122.55, 36.95], [-121.75, 36.95], [-121.75, 37.55], [-122.55, 37.55], [-122.55, 36.95]]] };
async function installSantaCruz(root: string): Promise<void> { return installPack(root, "santa-cruz-mountains", "scm-test", santaCruz); }

describe("catalog-linked pack discovery", () => {
  it("returns no installations when linked data is absent", async () => {
    expect((await discoverCatalogPacks(await emptyRoot())).size).toBe(0);
  });

  it("exposes metadata only for a valid linked installation", async () => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    const catalog = await discoverCatalogPacks(root);
    expect([...catalog.keys()]).toEqual(["santa-cruz-mountains"]);
    expect(catalog.get("santa-cruz-mountains")?.manifest.dataVersion).toBe("scm-test");
  });

  it("downgrades invalid linked installations without weakening direct-load validation", async () => {
    const root = await emptyRoot();
    await mkdir(path.join(root, "santa-cruz-mountains"), { recursive: true });
    await writeFile(path.join(root, "santa-cruz-mountains", "current.json"), "not json");
    const catalog = await discoverCatalogPacks(root);
    expect(catalog.size).toBe(0);
    await expect(loadInstalledPack("santa-cruz-mountains", root)).rejects.toThrow();
  });

  it("discovers local coverage and hides a legacy pack only after exact full coverage", async () => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    await installPack(root, "local-coverage", "coverage-test", santaCruz);
    expect([...((await discoverCatalogPacks(root)).keys())]).toEqual(["local-coverage"]);
  });

  it("retains legacy data under partial local coverage even when bounding boxes match", async () => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    const leftAndRight = { type: "MultiPolygon" as const, coordinates: [
      [[[-122.55,36.95],[-122.2,36.95],[-122.2,37.55],[-122.55,37.55],[-122.55,36.95]]],
      [[[-122.1,36.95],[-121.75,36.95],[-121.75,37.55],[-122.1,37.55],[-122.1,36.95]]],
    ] };
    await installPack(root, "local-coverage", "coverage-test", leftAndRight);
    expect([...((await discoverCatalogPacks(root)).keys())]).toEqual(["santa-cruz-mountains", "local-coverage"]);
  });

  it("keeps a valid legacy pack when the local pointer is invalid", async () => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    await mkdir(path.join(root, "local-coverage"), { recursive: true });
    await writeFile(path.join(root, "local-coverage", "current.json"), "invalid");
    expect([...((await discoverCatalogPacks(root)).keys())]).toEqual(["santa-cruz-mountains"]);
  });

  it.each([true, false])("checks actual supplemental routing (%s) when both manifests list its reference source", async (supplemental) => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    await installPack(root, "local-coverage", "coverage-test", santaCruz);
    for (const [id, version] of [["santa-cruz-mountains", "scm-test"], ["local-coverage", "coverage-test"]]) {
      const file = path.join(root, id!, version!, "manifest.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      manifest.sources.push({ ...manifest.sources[0], id: "usgs-national-digital-trails" });
      await writeFile(file, JSON.stringify(manifest));
    }
    const pack = (await loadInstalledPack("santa-cruz-mountains", root))!;
    const database = new DatabaseSync(pack.databasePath);
    if (supplemental) database.prepare("INSERT INTO edges VALUES(?,?,?)").run("official-gap-abc:0:forward", '["usgs-national-digital-trails"]', '["official-gap-id:official-gap-abc"]');
    database.close();
    expect(legacyRoutingNeedsReview(pack)).toBe(supplemental);
    expect([...((await discoverCatalogPacks(root)).keys())]).toEqual(supplemental ? ["santa-cruz-mountains", "local-coverage"] : ["local-coverage"]);
  });

  it.each(["county-trail-1:forward", "supplemental-trail-1:forward"])("retains unknown supplemental identity %s", async (id) => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    await installPack(root, "local-coverage", "coverage-test", santaCruz);
    const pack = (await loadInstalledPack("santa-cruz-mountains", root))!;
    const database = new DatabaseSync(pack.databasePath);
    database.prepare("INSERT INTO edges VALUES(?,?,?)").run(id, '["county"]', '[]');
    database.close();
    expect([...((await discoverCatalogPacks(root)).keys())]).toEqual(["santa-cruz-mountains", "local-coverage"]);
  });

  it("retains legacy data when routing provenance cannot be read", async () => {
    const root = await emptyRoot();
    await installSantaCruz(root);
    await installPack(root, "local-coverage", "coverage-test", santaCruz);
    const pack = (await loadInstalledPack("santa-cruz-mountains", root))!;
    await writeFile(pack.databasePath, "unreadable fixture");
    expect([...((await discoverCatalogPacks(root)).keys())]).toEqual(["santa-cruz-mountains", "local-coverage"]);
  });

});
