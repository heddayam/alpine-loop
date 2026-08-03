import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const apiUsage = sqliteTable(
  "api_usage",
  {
    provider: text("provider").notNull(),
    period: text("period").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.provider, table.period] })],
);

export const reachabilityJobs = sqliteTable(
  "reachability_jobs",
  {
    id: text("id").primaryKey().notNull(),
    requestKey: text("request_key").notNull(),
    providerJobId: text("provider_job_id"),
    status: text("status").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("idx_reachability_jobs_request_key").on(table.requestKey),
    index("idx_reachability_jobs_expires_at").on(table.expiresAt),
  ],
);
