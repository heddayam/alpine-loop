import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadInstalledPackVersion } from "./installed-pack";

const PACK_ID = "local-coverage";
const localLocks = new Map<string, Promise<void>>();

export class StaleGenerationError extends Error {
  constructor(readonly version: string) { super(`Local coverage generation ${version} is no longer installed`); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export type GenerationLock = {
  requireVersions(versions: readonly string[]): Promise<void>;
  pin(versions: readonly string[], token: string): Promise<void>;
  unpin(token: string): void;
  liveVersions(): Set<string>;
};

/** Serializes pin registration, active-pointer changes, saved-job creation, and cleanup. */
export async function withGenerationLock<T>(packRoot: string, action: (lock: GenerationLock) => Promise<T> | T): Promise<T> {
  const requestedDirectory = path.join(packRoot, PACK_ID);
  mkdirSync(requestedDirectory, { recursive: true });
  const directory = realpathSync(requestedDirectory);
  const file = path.join(directory, "generation-pins.sqlite");
  // DatabaseSync waits synchronously; queue callers in this process so one
  // cannot block the event loop while another holds an async transaction.
  const previous = localLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  localLocks.set(file, tail);
  await previous;
  try {
    const database = new DatabaseSync(file);
    try {
      database.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS generation_pins (
          token TEXT NOT NULL, pid INTEGER NOT NULL, version TEXT NOT NULL,
          PRIMARY KEY(token,version)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS generation_pins_version ON generation_pins(version);
      `);
      database.exec("BEGIN IMMEDIATE");
      const lock: GenerationLock = {
        async requireVersions(versions) {
          for (const version of new Set(versions)) {
            try { if (await loadInstalledPackVersion(PACK_ID, version, packRoot)) continue; }
            catch { /* Treat invalid generations the same as missing ones. */ }
            throw new StaleGenerationError(version);
          }
        },
        async pin(versions, token) {
          await lock.requireVersions(versions);
          const insert = database.prepare("INSERT INTO generation_pins VALUES (?,?,?)");
          for (const version of new Set(versions)) insert.run(token, process.pid, version);
        },
        unpin(token) { database.prepare("DELETE FROM generation_pins WHERE token=?").run(token); },
        liveVersions() {
          const result = new Set<string>();
          const rows = database.prepare("SELECT token,pid,version FROM generation_pins").all() as {token:string;pid:number;version:string}[];
          for (const row of rows) {
            if (alive(row.pid)) result.add(row.version);
            else database.prepare("DELETE FROM generation_pins WHERE token=? AND version=?").run(row.token, row.version);
          }
          return result;
        },
      };
      try {
        const value = await action(lock);
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally { database.close(); }
  } finally {
    release();
    if (localLocks.get(file) === tail) localLocks.delete(file);
  }
}

/** Keep selected generations installed until all in-flight readers finish. */
export async function withGenerationPins<T>(packRoot: string, versions: readonly string[], action: () => Promise<T>): Promise<T> {
  if (!versions.length) return action();
  const token = randomUUID();
  await withGenerationLock(packRoot, (lock) => lock.pin(versions, token));
  try { return await action(); }
  finally {
    // A concurrent cleanup sees the pin until its removal commits.
    await withGenerationLock(packRoot, (lock) => lock.unpin(token));
  }
}
