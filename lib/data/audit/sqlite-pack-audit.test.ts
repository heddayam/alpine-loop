import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { compilePack, type PackSeed } from "../compiler";
import { fixtureCompileOptions, fixtureCompileOptionsV2, fixtureCompileOptionsV3, fixtureCompileOptionsV4, fixturePackSeedV3 } from "../fixture-pack";
import { auditSqlitePack } from "./sqlite-pack-audit";

const temporaryDirectories: string[] = [];

async function buildFixture() {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "alpine-sqlite-audit-"));
  temporaryDirectories.push(outputRoot);
  return compilePack(await fixtureCompileOptions(outputRoot));
}

async function buildFixtureV2() {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "alpine-sqlite-audit-v2-"));
  temporaryDirectories.push(outputRoot);
  return compilePack(await fixtureCompileOptionsV2(outputRoot));
}

async function buildFixtureV3() {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "alpine-sqlite-audit-v3-"));
  temporaryDirectories.push(outputRoot);
  const seed = fixturePackSeedV3 as Extract<PackSeed, { schemaVersion: "3" }>;
  return compilePack(await fixtureCompileOptionsV3(outputRoot, undefined, undefined, {
    seed: {
      ...seed,
      dataVersion: `fixture-v3-primitive-${temporaryDirectories.length}`,
      closedRouteTopology: { ...seed.closedRouteTopology, runtimeMode: "primitive" },
    },
  }));
}

async function buildFixtureV4() {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "alpine-sqlite-audit-v4-"));
  temporaryDirectories.push(outputRoot);
  return compilePack(await fixtureCompileOptionsV4(outputRoot));
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
      dataVersion: "fixture-v1",
      counts: { nodes: 7, directedEdges: 17, accessPoints: 2, sources: 3, rejectedEdges: 1, conflicts: 0 },
      elevation: { missingNodeCount: 0, missingEdgeCount: 0 },
      unattributedRecordIds: [],
      unknownSourceReferenceRecordIds: [],
      implausibleMetricRecordIds: [],
      errors: [],
    });
    expect(audit.warnings).toContain(
      "Build audit reports rejected ways, not rejected directed edges; using rejectedWayCount as the available rejection count",
    );
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
    mutateDatabase(pack.databasePath, "UPDATE edges SET length_m = -1 WHERE id = 'w-ridge:0:forward'");

    const audit = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath });
    expect(audit.implausibleMetricRecordIds).toContain("w-ridge:0:forward");
    expect(audit.errors).toContain("1 edges have implausible metrics");
  });

  it("makes invalid build metrics explicit instead of inferring zero-conflict success", async () => {
    const pack = await buildFixture();
    await writeFile(pack.auditPath, JSON.stringify({ rejectedWayCount: -1, conflictCount: "none" }));

    const audit = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(audit.counts).toMatchObject({ rejectedEdges: 0, conflicts: 0 });
    expect(audit.errors).toEqual(expect.arrayContaining([
      "Invalid build audit rejectedWayCount; defaulted to 0 instead of assuming a successful build metric",
      "Invalid build audit conflictCount; defaulted to 0 instead of assuming a successful build metric",
    ]));
  });

  it("rejects manifest/database metadata and source mismatches", async () => {
    const pack = await buildFixture();
    mutateDatabase(pack.databasePath, "UPDATE metadata SET value = 'wrong-version' WHERE key = 'dataVersion'");
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow(/Manifest\/database mismatch for dataVersion/);

    mutateDatabase(pack.databasePath, `
      UPDATE metadata SET value = 'fixture-v1' WHERE key = 'dataVersion';
      UPDATE sources SET license = 'different' WHERE id = 'fixture-topology';
    `);
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow(/Manifest\/database source mismatch for fixture-topology.license/);
  });

  it("audits schema 2 named-area attribution and exact persisted coverage", async () => {
    const pack = await buildFixtureV2();
    const valid = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(valid.schemaVersion).toBe("2");
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

  it("audits schema 3 topology counts, complete member mapping, and bound content hashes", async () => {
    const pack = await buildFixtureV3();
    const valid = await auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath, auditPath: pack.auditPath });
    expect(valid.schemaVersion).toBe("3");
    expect(valid.counts).toMatchObject({ topologyProfiles: 2, topologyNetworks: 2 });
    expect(valid.errors).toEqual([]);

    mutateDatabase(pack.databasePath, "UPDATE topology_profiles SET content_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE profile='known'");
    await expect(auditSqlitePack({ databasePath: pack.databasePath, manifestPath: pack.manifestPath }))
      .rejects.toThrow("topology content hash mismatch");
  });

  it("fails closed on schema 3 topology count or member corruption", async () => {
    const countPack = await buildFixtureV3();
    mutateDatabase(countPack.databasePath, "UPDATE topology_profiles SET decision_edge_count=decision_edge_count+1 WHERE profile='known'");
    await expect(auditSqlitePack({ databasePath: countPack.databasePath, manifestPath: countPack.manifestPath }))
      .rejects.toThrow("topology count mismatch");

    const mappingPack = await buildFixtureV3();
    mutateDatabase(mappingPack.databasePath, "DELETE FROM topology_decision_edge_members WHERE profile='known' AND edge_key=(SELECT min(edge_key) FROM topology_decision_edge_members WHERE profile='known')");
    await expect(auditSqlitePack({ databasePath: mappingPack.databasePath, manifestPath: mappingPack.manifestPath }))
      .rejects.toThrow(/count mismatch|member mapping mismatch/);
  });

  it("audits schema 4 search-region rows and retained topology", async () => {
    const pack = await buildFixtureV4();
    const valid = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    expect(valid.schemaVersion).toBe("4");
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
});
