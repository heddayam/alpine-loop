import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteRouteJobStore } from "./store";
import { migrateLegacyJobs } from "./migration";
import legacyResult from "./fixtures/legacy-result.json";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const timestamp = "2026-01-01T00:00:00.000Z";
const completedAt = "2026-01-01T00:01:00.000Z";
const criteria = { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 4, max: 8 }, includeUncertainAccess: true };
const contour = { type: "Polygon", coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] };
const jobId = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function legacyDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "legacy-route-jobs-"));
  temporary.push(directory);
  const path = join(directory, "jobs.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(new URL("./fixtures/legacy-schema.sql", import.meta.url), "utf8"));
  return { database, path };
}

function insertJob(database: DatabaseSync, suffix: number, status: string, area: object = { searchRegionId: "region" }) {
  database.prepare(`INSERT INTO route_jobs(id, request_json, pack_id, pack_data_version, pack_built_at,
    search_region_id, search_region_name, status, created_at, updated_at, started_at, completed_at)
    VALUES (?, ?, 'old-pack', 'old-version', ?, 'region', 'Old region', ?, ?, ?, ?, ?)`).run(
    jobId(suffix), JSON.stringify({ version: 1, packId: "old-pack", routesPerAccessPoint: 10, criteria, ...area }),
    timestamp, status, timestamp, completedAt, timestamp, ["completed", "cancelled", "failed"].includes(status) ? completedAt : null,
  );
  database.prepare(`INSERT INTO route_job_access_points(job_id, ordinal, access_point_id, status, truncated,
    diagnostics_json, started_at, completed_at) VALUES (?, 0, 'access', 'done', 1, '{"attempts":3}', ?, ?)`).run(jobId(suffix), timestamp, completedAt);
  database.prepare(`INSERT INTO route_job_access_points(job_id, ordinal, access_point_id, status)
    VALUES (?, 1, 'pending', 'pending')`).run(jobId(suffix));
  database.prepare(`INSERT INTO route_job_results(job_id, match_rank, access_ordinal, result_ordinal, route_id, payload_json)
    VALUES (?, 0, 0, 0, 'loop', ?)`).run(jobId(suffix), JSON.stringify(legacyResult));
}

describe("geographic job migration", () => {
  it("preserves saved geometry, all rows, ordinals and timestamps while replacing pack columns", () => {
    const { database, path } = legacyDatabase();
    insertJob(database, 1, "completed");
    insertJob(database, 2, "cancelled", { drawnAreaBbox: [-122.4, 37.1, -122.2, 37.3] });
    insertJob(database, 3, "failed", { origin: { lon: -122.1, lat: 37.3, label: "Home" }, durationMinutes: 30, searchRegionId: "region" });
    database.prepare("UPDATE route_jobs SET drive_time_geometry_json = ?, drive_time_resolved_at = ?, error = 'failure' WHERE id = ?")
      .run(JSON.stringify(contour), timestamp, jobId(3));
    const duplicate = { ...legacyResult, route: { ...legacyResult.route, id: "duplicate" } };
    database.prepare(`INSERT INTO route_job_results(job_id, match_rank, access_ordinal, result_ordinal, route_id, payload_json)
      VALUES (?, 0, 0, 1, 'duplicate', ?)`).run(jobId(1), JSON.stringify(duplicate));
    database.close();

    const store = new SQLiteRouteJobStore(path);
    expect(store.listIds()).toHaveLength(3);
    expect(store.toPublic(jobId(1), true)).toMatchObject({
      version: 2, status: "completed", stale: true, createdAt: timestamp, updatedAt: completedAt, completedAt,
      request: { area: { mode: "named-regions", regionIds: ["old-pack::region"] }, criteria },
      area: { label: "Old region" },
      progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 1, exactRouteCount: 2, truncatedAccessPointCount: 1, elapsedMs: 60_000 },
    });
    expect(store.getStored(jobId(1))?.plan).toEqual({ packs: [{ id: "old-pack", dataVersion: "old-version", builtAt: timestamp }], area: { label: "Old region" } });
    expect(store.toPublic(jobId(2), false)).toMatchObject({ status: "cancelled", partial: true, area: { filterGeometry: { type: "Polygon" } } });
    expect(store.toPublic(jobId(3), false)).toMatchObject({ status: "failed", error: "failure", area: { filterGeometry: contour } });
    const results = store.pageResults(jobId(1), undefined, 50).results;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ...legacyResult, accessPointId: "old-pack::access", route: {
      ...legacyResult.route, id: "old-pack::loop", regionLabel: "Old region",
      startAccessPoint: { ...legacyResult.route.startAccessPoint, id: "old-pack::access" },
      trailSegments: legacyResult.route.trailSegments.map((segment) => ({ ...segment, id: "old-pack::segment" })),
    } });
    store.close();

    const reopened = new SQLiteRouteJobStore(path);
    expect(reopened.pageResults(jobId(1), undefined, 50).results).toEqual(results);
    reopened.requestDelete(jobId(1));
    reopened.close();
    const inspect = new DatabaseSync(path);
    expect(inspect.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const columns = inspect.prepare("PRAGMA table_info(route_jobs)").all().map(({ name }) => name);
    expect(columns).toContain("plan_json");
    expect(columns).not.toContain("pack_id");
    expect(columns).not.toContain("search_region_id");
    expect(inspect.prepare("SELECT * FROM route_job_results WHERE job_id = ?").all(jobId(1))).toEqual([]);
    expect(inspect.prepare("SELECT * FROM route_job_access_points WHERE job_id = ?").all(jobId(1))).toEqual([]);
    expect(inspect.prepare("SELECT diagnostics_json, started_at, completed_at FROM route_job_access_points WHERE job_id = ? AND ordinal = 0").get(jobId(2)))
      .toEqual({ diagnostics_json: '{"attempts":3}', started_at: timestamp, completed_at: completedAt });
    inspect.close();
  });

  it("resumes the original next ordinal and honors interrupted cancellation and deletion", () => {
    const { database, path } = legacyDatabase();
    insertJob(database, 1, "running");
    insertJob(database, 2, "resolving-drive-time");
    insertJob(database, 3, "deleting");
    database.prepare("UPDATE route_job_access_points SET status = 'running', started_at = ? WHERE job_id = ? AND ordinal = 1").run(timestamp, jobId(1));
    database.prepare("UPDATE route_jobs SET cancel_requested = 1 WHERE id = ?").run(jobId(2));
    database.prepare("UPDATE route_jobs SET delete_requested = 1 WHERE id = ?").run(jobId(3));
    database.close();
    const store = new SQLiteRouteJobStore(path);
    expect(store.claimNext()?.id).toBe(jobId(1));
    store.initializeAccessPoints(jobId(1), ["old-pack::pending", "old-pack::access"]);
    expect(store.nextAccessPoint(jobId(1))).toEqual({ ordinal: 1, accessPointId: "old-pack::pending" });
    expect(store.pageResults(jobId(1), undefined, 50).results).toHaveLength(1);
    expect(store.getControl(jobId(2))?.status).toBe("cancelled");
    expect(store.getStored(jobId(3))).toBeNull();
    expect(store.claimNext()).toBeNull();
    store.close();
  });

  it("migrates close matches from storage that already has a unique geometry index", () => {
    const { database, path } = legacyDatabase();
    insertJob(database, 1, "completed");
    database.exec("ALTER TABLE route_job_results ADD COLUMN geometry_hash TEXT; CREATE UNIQUE INDEX route_job_results_geometry ON route_job_results(job_id, geometry_hash)");
    const near = { ...legacyResult, matchType: "near-miss", route: { ...legacyResult.route,
      violations: [{ constraint: "distance", value: 3, min: 4, max: 8, delta: 1, normalizedDelta: 0.125 }],
    } };
    database.prepare("UPDATE route_job_results SET match_rank = 1, payload_json = ?, geometry_hash = 'old-hash'").run(JSON.stringify(near));
    database.close();
    const store = new SQLiteRouteJobStore(path);
    const result = store.pageResults(jobId(1), undefined, 50).results[0];
    expect(result).toMatchObject({ matchType: "near-miss", route: { violations: near.route.violations, geometry: near.route.geometry } });
    store.close();
  });

  it("rolls back both schema and child changes if a saved payload cannot migrate", () => {
    const { database } = legacyDatabase();
    insertJob(database, 1, "completed");
    insertJob(database, 2, "completed");
    database.prepare("UPDATE route_job_results SET payload_json = '{}' WHERE job_id = ?").run(jobId(2));
    expect(() => migrateLegacyJobs(database)).toThrow();
    expect(database.prepare("PRAGMA table_info(route_jobs)").all().map(({ name }) => name)).toContain("pack_id");
    expect(database.prepare("SELECT access_point_id FROM route_job_access_points WHERE job_id = ? AND ordinal = 0").get(jobId(1)))
      .toEqual({ access_point_id: "access" });
    expect(database.prepare("SELECT payload_json FROM route_job_results WHERE job_id = ?").get(jobId(1))?.payload_json).toBe(JSON.stringify(legacyResult));
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    database.close();
  });
});
