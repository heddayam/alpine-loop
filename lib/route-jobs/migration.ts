import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  areaGeometrySchema, bboxSchema, driveTimeDurationSchema, originSchema,
  routeCriteriaSchema, routeJobResultV2Schema, searchIntentSchema, generatedClosedRouteV3Schema, constraintViolationV3Schema,
} from "@/lib/contracts";
import type { SearchPlan } from "@/lib/server/search-plan";

export const JOB_COLUMNS = `
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL,
  drive_time_resolved_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
  delete_requested INTEGER NOT NULL DEFAULT 0 CHECK(delete_requested IN (0, 1)),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
`;

// Version-one storage is read only here; new jobs never carry these fields.
const legacyRequestSchema = z.object({
  version: z.literal(1),
  origin: originSchema.optional(),
  durationMinutes: driveTimeDurationSchema.optional(),
  searchRegionId: z.string().optional(),
  drawnAreaBbox: bboxSchema.optional(),
  criteria: routeCriteriaSchema,
});

const legacyResultSchema = z.object({
  matchType: z.enum(["exact", "near-miss"]), accessPointId: z.string().min(1),
  route: generatedClosedRouteV3Schema.extend({ violations: z.array(constraintViolationV3Schema).optional() }),
});

/** Replace the parent table without rewriting its children's foreign keys. */
export function migrateLegacyJobs(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(route_jobs)").all();
  if (columns.length === 0 || columns.some(({ name }) => name === "plan_json")) return;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    database.exec(`CREATE TABLE route_jobs_next (${JOB_COLUMNS}) STRICT;`);
    const resultColumns = database.prepare("PRAGMA table_info(route_job_results)").all();
    if (!resultColumns.some(({ name }) => name === "geometry_hash")) {
      database.exec("ALTER TABLE route_job_results ADD COLUMN geometry_hash TEXT");
    }
    const insert = database.prepare(`INSERT INTO route_jobs_next (
      id, request_json, plan_json, status, drive_time_resolved_at, cancel_requested,
      delete_requested, error, created_at, updated_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of database.prepare("SELECT * FROM route_jobs").all()) {
      const legacy = legacyRequestSchema.parse(JSON.parse(String(row.request_json)));
      const prefix = (id: string) => `${row.pack_id}::${id}`;
      const regionIds = legacy.searchRegionId ? [prefix(legacy.searchRegionId)] : [];
      const request = searchIntentSchema.parse({
        criteria: legacy.criteria,
        area: legacy.drawnAreaBbox
          ? { mode: "drawn-area", bbox: legacy.drawnAreaBbox }
          : legacy.origin && legacy.durationMinutes !== undefined
            ? { mode: "drive-time", origin: legacy.origin, durationMinutes: legacy.durationMinutes, regionIds }
            : { mode: "named-regions", regionIds },
      });
      const plan: SearchPlan = {
        packs: [{ id: String(row.pack_id), dataVersion: String(row.pack_data_version), builtAt: String(row.pack_built_at) }],
        area: { label: String(row.search_region_name) },
      };
      if (row.drive_time_geometry_json !== null) {
        plan.area.filterGeometry = areaGeometrySchema.parse(JSON.parse(String(row.drive_time_geometry_json)));
      } else if (request.area.mode === "drawn-area") {
        const [west, south, east, north] = request.area.bbox;
        plan.area.filterGeometry = {
          type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        };
      }
      insert.run(row.id, JSON.stringify(request), JSON.stringify(plan), row.status, row.drive_time_resolved_at,
        row.cancel_requested, row.delete_requested, row.error, row.created_at, row.updated_at, row.started_at, row.completed_at);
      database.prepare("UPDATE route_job_access_points SET access_point_id = ? || access_point_id WHERE job_id = ?")
        .run(`${row.pack_id}::`, row.id);
      for (const saved of database.prepare("SELECT rowid, payload_json FROM route_job_results WHERE job_id = ?").all(row.id)) {
        const old = legacyResultSchema.parse(JSON.parse(String(saved.payload_json)));
        const route = old.route;
        const result = routeJobResultV2Schema.parse({
          ...old, accessPointId: prefix(old.accessPointId),
          route: {
            ...route, id: prefix(route.id), regionLabel: String(row.search_region_name),
            startAccessPoint: { ...route.startAccessPoint, id: prefix(route.startAccessPoint.id) },
            ...(route.trailSegments ? { trailSegments: route.trailSegments.map((segment) => ({ ...segment, id: prefix(segment.id) })) } : {}),
          },
        });
        const hash = createHash("sha256").update(JSON.stringify(result.route.geometry.coordinates)).digest("hex");
        database.prepare("UPDATE route_job_results SET route_id = ?, payload_json = ?, geometry_hash = ? WHERE rowid = ?")
          .run(result.route.id, JSON.stringify(result), hash, saved.rowid);
      }
    }
    database.exec("DROP TABLE route_jobs; ALTER TABLE route_jobs_next RENAME TO route_jobs;");
    if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Route-job migration broke a foreign key");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
