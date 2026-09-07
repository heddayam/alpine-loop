-- Original version-one storage, before geometry deduplication.
CREATE TABLE IF NOT EXISTS route_job_migrations (
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS route_jobs (
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  pack_data_version TEXT NOT NULL,
  pack_built_at TEXT NOT NULL,
  search_region_id TEXT NOT NULL,
  search_region_name TEXT NOT NULL,
  status TEXT NOT NULL,
  drive_time_geometry_json TEXT,
  drive_time_resolved_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
  delete_requested INTEGER NOT NULL DEFAULT 0 CHECK(delete_requested IN (0, 1)),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS route_jobs_queue ON route_jobs(status, created_at, id);
CREATE TABLE IF NOT EXISTS route_job_access_points (
  job_id TEXT NOT NULL REFERENCES route_jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  access_point_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed')),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
  diagnostics_json TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY(job_id, ordinal),
  UNIQUE(job_id, access_point_id)
) STRICT;
CREATE TABLE IF NOT EXISTS route_job_results (
  job_id TEXT NOT NULL REFERENCES route_jobs(id) ON DELETE CASCADE,
  match_rank INTEGER NOT NULL CHECK(match_rank IN (0, 1)),
  access_ordinal INTEGER NOT NULL CHECK(access_ordinal >= 0),
  result_ordinal INTEGER NOT NULL CHECK(result_ordinal >= 0),
  route_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(job_id, match_rank, access_ordinal, result_ordinal, route_id),
  UNIQUE(job_id, route_id)
) STRICT;
CREATE INDEX IF NOT EXISTS route_job_results_order
  ON route_job_results(job_id, match_rank, access_ordinal, result_ordinal, route_id);
