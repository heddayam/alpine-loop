export const GOOGLE_ISOCHRONE_MONTHLY_LIMIT = 9_000;
export const ARCGIS_SERVICE_AREA_MONTHLY_LIMIT = 4_500;

export const GOOGLE_ISOCHRONE_PROVIDER = "google-isochrones";
export const ARCGIS_SERVICE_AREA_PROVIDER = "arcgis-service-areas";

export function utcMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function secondsUntilNextUtcMonth(date = new Date()) {
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((nextMonth - date.getTime()) / 1_000));
}

export type UsageReservation = {
  limit: number;
  period: string;
  remaining: number;
  used: number;
};

/**
 * Atomically reserves one upstream request. If the counter cannot be checked,
 * this throws so callers fail closed and never contact the paid API.
 */
export async function reserveProviderRequest(
  provider: string,
  limit: number,
  date = new Date(),
): Promise<UsageReservation | null> {
  const { env } = await import("cloudflare:workers");

  if (!env.DB) {
    throw new Error("The API usage database is unavailable.");
  }

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS api_usage (
      provider TEXT NOT NULL,
      period TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, period)
    )`,
  ).run();

  const period = utcMonth(date);
  const row = await env.DB.prepare(
    `INSERT INTO api_usage (provider, period, count, updated_at)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(provider, period) DO UPDATE SET
       count = api_usage.count + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE api_usage.count < ?
     RETURNING count`,
  )
    .bind(provider, period, limit)
    .first<{ count: number }>();

  if (!row) {
    return null;
  }

  return {
    limit,
    period,
    remaining: limit - row.count,
    used: row.count,
  };
}

export async function getProviderUsage(
  provider: string,
  limit: number,
  date = new Date(),
): Promise<UsageReservation> {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("The API usage database is unavailable.");
  const period = utcMonth(date);
  const row = await env.DB.prepare(
    "SELECT count FROM api_usage WHERE provider = ? AND period = ?",
  )
    .bind(provider, period)
    .first<{ count: number }>();
  const used = row?.count ?? 0;
  return { limit, period, remaining: Math.max(0, limit - used), used };
}

export function reserveGoogleIsochroneRequest(date = new Date()) {
  return reserveProviderRequest(
    GOOGLE_ISOCHRONE_PROVIDER,
    GOOGLE_ISOCHRONE_MONTHLY_LIMIT,
    date,
  );
}
