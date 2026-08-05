import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ARCGIS_GEOCODING_MONTHLY_LIMIT = 9_000;
export const ARCGIS_SERVICE_AREA_MONTHLY_LIMIT = 4_500;
export const ARCGIS_GEOCODING_PROVIDER = "arcgis-geocoding";
export const ARCGIS_SERVICE_AREA_PROVIDER = "arcgis-service-areas";

export type UsageReservation = {
  provider: string;
  period: string;
  limit: number;
  used: number;
  remaining: number;
};

export interface UsageStore {
  reserve(provider: string, limit: number, now: Date): Promise<UsageReservation | null>;
  get(provider: string, limit: number, now: Date): Promise<UsageReservation>;
}

export function utcMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function secondsUntilNextUtcMonth(date: Date): number {
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - date.getTime()) / 1_000));
}

/** SQLite contains aggregate provider/month counts only—never location data. */
export class SqliteUsageStore implements UsageStore {
  private database?: DatabaseSync;

  constructor(private readonly filename: string) {}

  private db(): DatabaseSync {
    if (this.database) return this.database;
    if (this.filename !== ":memory:") mkdirSync(dirname(this.filename), { recursive: true });
    const database = new DatabaseSync(this.filename);
    database.exec(`CREATE TABLE IF NOT EXISTS provider_usage (
      provider TEXT NOT NULL,
      period TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, period)
    ) STRICT`);
    this.database = database;
    return database;
  }

  async reserve(provider: string, limit: number, now: Date): Promise<UsageReservation | null> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid provider usage limit");
    const period = utcMonth(now);
    const row = this.db().prepare(`INSERT INTO provider_usage
      (provider, period, count, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(provider, period) DO UPDATE SET
        count = count + 1,
        updated_at = excluded.updated_at
      WHERE count < ?
      RETURNING count`).get(provider, period, now.toISOString(), limit) as { count: number } | undefined;
    if (!row) return null;
    return {
      provider,
      period,
      limit,
      used: row.count,
      remaining: Math.max(0, limit - row.count),
    };
  }

  async get(provider: string, limit: number, now: Date): Promise<UsageReservation> {
    const period = utcMonth(now);
    const row = this.db().prepare(
      "SELECT count FROM provider_usage WHERE provider = ? AND period = ?",
    ).get(provider, period) as { count: number } | undefined;
    const used = row?.count ?? 0;
    return { provider, period, limit, used, remaining: Math.max(0, limit - used) };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
