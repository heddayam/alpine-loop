export const REACHABILITY_JOB_TTL_SECONDS = 30 * 60;

export type ReachabilityJob = {
  id: string;
  requestKey: string;
  providerJobId: string | null;
  status: string;
  latitude: number;
  longitude: number;
  durationMinutes: number;
  createdAt: number;
  expiresAt: number;
  error: string | null;
};

function rowToJob(row: Record<string, unknown>): ReachabilityJob {
  return {
    id: String(row.id),
    requestKey: String(row.request_key),
    providerJobId: typeof row.provider_job_id === "string" ? row.provider_job_id : null,
    status: String(row.status),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    durationMinutes: Number(row.duration_minutes),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    error: typeof row.error === "string" ? row.error : null,
  };
}

async function getDatabase() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("The API usage database is unavailable.");
  return env.DB;
}

async function ensureSchema() {
  const database = await getDatabase();
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS reachability_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      request_key TEXT NOT NULL UNIQUE,
      provider_job_id TEXT,
      status TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      duration_minutes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      error TEXT
    )`),
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_reachability_jobs_expires_at
      ON reachability_jobs(expires_at)`),
  ]);
  return database;
}

export async function deleteExpiredReachabilityJobs(now: number) {
  const database = await ensureSchema();
  await database.prepare("DELETE FROM reachability_jobs WHERE expires_at <= ?").bind(now).run();
}

export async function getReachabilityJob(id: string): Promise<ReachabilityJob | null> {
  const database = await ensureSchema();
  const row = await database.prepare("SELECT * FROM reachability_jobs WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowToJob(row) : null;
}

export async function findReachabilityJob(
  requestKey: string,
  now: number,
): Promise<ReachabilityJob | null> {
  const database = await ensureSchema();
  const row = await database.prepare(
    `SELECT * FROM reachability_jobs
     WHERE request_key = ? AND expires_at > ? AND status != 'failed'`,
  )
    .bind(requestKey, now)
    .first<Record<string, unknown>>();
  return row ? rowToJob(row) : null;
}

export async function createReachabilityJob(input: {
  id: string;
  requestKey: string;
  latitude: number;
  longitude: number;
  durationMinutes: number;
  now: number;
}): Promise<boolean> {
  const database = await ensureSchema();
  const result = await database.prepare(
    `INSERT INTO reachability_jobs
      (id, request_key, status, latitude, longitude, duration_minutes, created_at, expires_at)
     VALUES (?, ?, 'submitting', ?, ?, ?, ?, ?)
     ON CONFLICT(request_key) DO UPDATE SET
       id = excluded.id,
       provider_job_id = NULL,
       status = 'submitting',
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       duration_minutes = excluded.duration_minutes,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at,
       error = NULL
     WHERE reachability_jobs.status = 'failed'`,
  )
    .bind(
      input.id,
      input.requestKey,
      input.latitude,
      input.longitude,
      input.durationMinutes,
      input.now,
      input.now + REACHABILITY_JOB_TTL_SECONDS,
    )
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function updateReachabilityJob(
  id: string,
  input: { status: string; providerJobId?: string; error?: string },
) {
  const database = await ensureSchema();
  await database.prepare(
    `UPDATE reachability_jobs SET
      status = ?,
      provider_job_id = COALESCE(?, provider_job_id),
      error = ?
     WHERE id = ?`,
  )
    .bind(input.status, input.providerJobId ?? null, input.error ?? null, id)
    .run();
}

export async function deleteReachabilityJob(id: string) {
  const database = await ensureSchema();
  await database.prepare("DELETE FROM reachability_jobs WHERE id = ?").bind(id).run();
}
