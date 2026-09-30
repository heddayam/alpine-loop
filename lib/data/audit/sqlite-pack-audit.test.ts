import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { packManifestSchema } from "@/lib/contracts";
import { compilePack } from "../testing/compiler";
import { fixtureCompileOptions, fixturePackSeed } from "../fixture-pack";
import { auditSqlitePack } from "./sqlite-pack-audit";

const temporaryDirectories: string[] = [];

async function buildFixture() {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "alpine-sqlite-audit-"));
  temporaryDirectories.push(outputRoot);
  return compilePack(await fixtureCompileOptions(outputRoot));
}

function mutateDatabase(databasePath: string, sql: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite regional pack audit extraction", () => {
  it("audits a compiler-built pack read-only with complete attribution and build metrics", async () => {
    const pack = await buildFixture();
    const audit = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });

    expect(audit).toMatchObject({
      packId: "fixture-pack",
      dataVersion: fixturePackSeed.dataVersion,
      counts: { nodes: 7, directedEdges: 17, accessPoints: 2, sources: 4, rejectedEdges: 0, conflicts: 0 },
      elevation: { missingNodeCount: 0, missingEdgeCount: 0 },
      unattributedRecordIds: [],
      unknownSourceReferenceRecordIds: [],
      implausibleMetricRecordIds: [],
      errors: [],
    });
    expect(audit.warnings).toEqual([]);
  });

  it("reports missing and unknown source attribution extracted from JSON columns", async () => {
    const pack = await buildFixture();
    mutateDatabase(pack.databasePath, `
      UPDATE edges SET source_refs = '[]' WHERE id = 'w-ridge:0:forward';
      UPDATE access_points SET source_refs = '["missing-source"]' WHERE id = 'access-n-a';
    `);

    const audit = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath });
    expect(audit.unattributedRecordIds).toContain("edge:w-ridge:0:forward");
    expect(audit.unknownSourceReferenceRecordIds).toContain("access-point:access-n-a");
    expect(audit.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/records have no source attribution/),
      expect.stringMatching(/records reference unknown sources/),
    ]));
  });

  it("passes persisted invalid edge metrics to the audit instead of sanitizing them", async () => {
    const pack = await buildFixture();
    mutateDatabase(pack.databasePath, "UPDATE edges SET gain_m = -1 WHERE id = 'w-ridge:0:forward'");

    const audit = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath });
    expect(audit.implausibleMetricRecordIds).toContain("w-ridge:0:forward");
    expect(audit.errors).toContain("1 edges have implausible metrics");
  });

  it("makes invalid build metrics explicit instead of inferring zero-conflict success", async () => {
    const pack = await buildFixture();
    await writeFile(pack.auditPath, JSON.stringify({ rejectedCoverageEdgeCount: -1, conflictCount: "none" }));

    const audit = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(audit.counts).toMatchObject({ rejectedEdges: 0, conflicts: 0 });
    expect(audit.errors).toEqual(expect.arrayContaining([
      "Invalid build audit rejectedCoverageEdgeCount; defaulted to 0 instead of assuming a successful build metric",
      "Invalid build audit conflictCount; defaulted to 0 instead of assuming a successful build metric",
    ]));
  });

  it("rejects manifest/database metadata and source mismatches", async () => {
    const pack = await buildFixture();
    mutateDatabase(pack.databasePath, "UPDATE metadata SET value = 'wrong-version' WHERE key = 'dataVersion'");
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow(/Manifest\/database mismatch for dataVersion/);

    mutateDatabase(pack.databasePath, `
      UPDATE metadata SET value = '${fixturePackSeed.dataVersion}' WHERE key = 'dataVersion';
      UPDATE sources SET license = 'different' WHERE id = 'fixture-topology';
    `);
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow(/Manifest\/database source mismatch for fixture-topology.license/);
  });

  it("audits named-area attribution and exact persisted coverage", async () => {
    const pack = await buildFixture();
    const valid = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(valid.schemaVersion).toBe("6");
    expect(valid.counts.namedAreas).toBe(3);
    expect(valid.outsideCoverageEdgeIds).toEqual([]);
    expect(valid.errors).toEqual([]);

    mutateDatabase(pack.databasePath, `
      UPDATE edges SET geometry = '[[0,0],[1,1]]' WHERE id = 'w-loop:0:forward';
      UPDATE named_areas SET source_refs = '["missing-source"]' WHERE id = 'osm:relation/1001';
    `);
    const corrupt = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(corrupt.outsideCoverageEdgeIds).toEqual(["w-loop:0:forward"]);
    expect(corrupt.errors).toEqual(expect.arrayContaining([
      "Named area osm:relation/1001 references an unknown source",
      "1 persisted edges leave exact pack coverage",
    ]));
  });

  it("audits topology counts, access feasibility, and bound content hashes", async () => {
    const pack = await buildFixture();
    const valid = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath, auditPath: pack.auditPath });
    expect(valid.schemaVersion).toBe("6");
    expect(valid.counts).toMatchObject({ topologyProfiles: 2, topologyNetworks: 0 });
    expect(valid.errors).toEqual([]);

    mutateDatabase(pack.databasePath, "UPDATE topology_profiles SET content_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE profile='known'");
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow("topology content hash mismatch");
  });

  it("independently checks changed reverse geometry, including its interior coordinates", async () => {
    const pack = await buildFixture();
    // Endpoints still reverse the forward edge; only the changed interior point
    // leaves coverage. The persisted physical identity is unchanged.
    mutateDatabase(pack.databasePath, `
      UPDATE edges SET geometry = '[[-122.159,37.16],[-122.158,37.16],[-122.157,37.16]]' WHERE id = 'w-loop:0:forward';
      UPDATE edges SET geometry = '[[-122.157,37.16],[0,0],[-122.159,37.16]]' WHERE id = 'w-loop:0:reverse';
    `);
    const audit = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath });
    expect(audit.outsideCoverageEdgeIds).toEqual(["w-loop:0:reverse"]);
    expect(audit.errors).toContain("1 persisted edges leave exact pack coverage");
  });

  it("reports both directions of identical geometry outside coverage in persisted order", async () => {
    const pack = await buildFixture();
    mutateDatabase(pack.databasePath, `
      UPDATE edges SET geometry = '[[0,0],[1,1]]' WHERE id = 'w-loop:0:forward';
      UPDATE edges SET geometry = '[[1,1],[0,0]]' WHERE id = 'w-loop:0:reverse';
    `);
    const audit = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath });
    expect(audit.outsideCoverageEdgeIds).toEqual(["w-loop:0:forward", "w-loop:0:reverse"]);
    expect(audit.errors).toContain("2 persisted edges leave exact pack coverage");
  });

  it.each([
    {
      name: "hole crossing with inside endpoints", inside: false,
      boundary: { type: "Polygon", coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ] }, geometry: [[2, 5], [8, 5]],
    },
    {
      name: "concave crossing with inside endpoints", inside: false,
      boundary: { type: "Polygon", coordinates: [
        [[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6], [0, 0]],
      ] }, geometry: [[1, 5], [5, 5]],
    },
    {
      name: "disjoint islands", inside: false,
      boundary: { type: "MultiPolygon", coordinates: [
        [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
        [[[8, 8], [10, 8], [10, 10], [8, 10], [8, 8]]],
      ] }, geometry: [[1, 1], [9, 9]],
    },
    {
      name: "outer boundary contact", inside: true,
      boundary: { type: "Polygon", coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      ] }, geometry: [[0, 0], [10, 0]],
    },
    {
      name: "hole boundary contact", inside: true,
      boundary: { type: "Polygon", coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ] }, geometry: [[4, 4], [6, 4]],
    },
  ])("preserves exact coverage in both directions for $name", async ({ boundary, geometry, inside }) => {
    const pack = await buildFixture();
    const manifest = packManifestSchema.parse(JSON.parse(await readFile(pack.manifestPath, "utf8")));
    await writeFile(pack.manifestPath, JSON.stringify({ ...manifest, coverage: { bbox: [0, 0, 10, 10], boundary } }));
    mutateDatabase(pack.databasePath, `
      UPDATE edges SET geometry = '[[1,1],[1,2]]';
      UPDATE edges SET geometry = '${JSON.stringify(geometry)}' WHERE id = 'w-loop:0:forward';
      UPDATE edges SET geometry = '${JSON.stringify([...geometry].reverse())}' WHERE id = 'w-loop:0:reverse';
    `);
    const audit = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath });
    expect(audit.outsideCoverageEdgeIds).toEqual(inside ? [] : ["w-loop:0:forward", "w-loop:0:reverse"]);
  });

  it("retains persisted profile error ordering across malformed and incomplete rows", async () => {
    const pack = await buildFixture();
    mutateDatabase(pack.databasePath, `
      UPDATE edges SET elevation_profile = '[[0,100,1]]' WHERE edge_key = (SELECT min(edge_key) FROM edges);
      UPDATE edges SET elevation_profile = 'not-json' WHERE edge_key = (SELECT max(edge_key) FROM edges);
    `);
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow(/Edge .+ has no complete elevation profile; Edge .+ has no complete elevation profile/);
  });

  it("fails closed on topology count or access corruption", async () => {
    const versionPack = await buildFixture();
    mutateDatabase(versionPack.databasePath, "UPDATE topology_profiles SET format_version=99 WHERE profile='known'");
    await expect(auditSqlitePack({ databasePath: versionPack.databasePath, manifestPath: versionPack.manifestPath }))
      .rejects.toThrow(/Unsupported known topology format version/);
    const countPack = await buildFixture();
    mutateDatabase(countPack.databasePath, "UPDATE topology_profiles SET decision_edge_count=decision_edge_count+1 WHERE profile='known'");
    await expect(auditSqlitePack({ databasePath: countPack.databasePath, manifestPath: countPack.manifestPath }))
      .rejects.toThrow("topology count mismatch");

    const mappingPack = await buildFixture();
    mutateDatabase(mappingPack.databasePath, "DELETE FROM access_topology WHERE profile='known' AND access_point_id='access-n-a'");
    await expect(auditSqlitePack({ databasePath: mappingPack.databasePath, manifestPath: mappingPack.manifestPath }))
      .rejects.toThrow(/access topology count mismatch/);
  });

  it("audits search-region rows and retained topology", async () => {
    const pack = await buildFixture();
    const valid = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(valid.schemaVersion).toBe("6");
    expect(valid.counts).toMatchObject({ searchRegions: 2, topologyProfiles: 2 });
    expect(valid.errors).toEqual([]);

    mutateDatabase(pack.databasePath, `
      UPDATE search_regions SET display_order = 8 WHERE named_area_id = 'osm:relation/1001';
      UPDATE named_areas SET name = 'Redwood Preserve Closed Area' WHERE id = 'osm:relation/1001';
    `);
    const corrupt = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(corrupt.errors).toEqual(expect.arrayContaining([
      "Search region osm:relation/1001 has non-contiguous display order 8; expected 1",
      "Search region osm:relation/1001 refers to a closed-area variant",
    ]));
  });

  it("audits schema 6 portal measurements and rejects published road context", async () => {
    const pack = await buildFixture();
    const valid = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(valid.schemaVersion).toBe("6");
    expect(valid.errors).toEqual([]);

    mutateDatabase(pack.databasePath, "UPDATE edges SET edge_class = 'street' WHERE id = (SELECT min(id) FROM edges)");
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow(/build-only road or sidewalk edges were published/);
  });
});
