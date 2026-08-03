export const GOOGLE_ISOCHRONE_MONTHLY_LIMIT = 9_000;

const PROVIDER = "google-isochrones";

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
export async function reserveGoogleIsochroneRequest(
  date = new Date(),
): Promise<UsageReservation | null> {
  const { env } = await import("cloudflare:workers");

  if (!env.DB) {
    throw new Error("The API usage database is unavailable.");
  }

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
    .bind(PROVIDER, period, GOOGLE_ISOCHRONE_MONTHLY_LIMIT)
    .first<{ count: number }>();

  if (!row) {
    return null;
  }

  return {
    limit: GOOGLE_ISOCHRONE_MONTHLY_LIMIT,
    period,
    remaining: GOOGLE_ISOCHRONE_MONTHLY_LIMIT - row.count,
    used: row.count,
  };
}
