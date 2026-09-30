import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";

const SQLITE_CHECK = `const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.argv[1],{readOnly:true}),mode=process.argv[2];
try { db.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
  process.stdout.write(String(db.prepare("PRAGMA "+mode).get()?.[mode] ?? "no result")); }
finally { db.close(); }`;

/** Keep the worker responsive while SQLite scans a large, file-backed source. */
export async function checkSQLiteIntegrity(file: string, db: DatabaseSync, checkpoint: () => Promise<void>, mode: "quick_check" | "integrity_check" = "quick_check"): Promise<void> {
  if (file === ":memory:") {
    const result = db.prepare("PRAGMA "+mode).get() as Record<string, string> | undefined;
    if (result?.[mode] !== "ok") throw new Error(`Staged source failed SQLite ${mode}: ${result?.[mode] ?? "no result"}`);
    return;
  }
  const child = spawn(process.execPath, ["-e", SQLITE_CHECK, file, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-4096); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  let childError: Error | undefined;
  let outcome: { code: number | null; reason: string } | undefined;
  const ended = new Promise<void>((resolve) => {
    child.once("error", (error) => { childError = error; });
    child.once("close", (code, signal) => { outcome = { code, reason: childError?.message ?? signal ?? stderr.trim() }; resolve(); });
  });
  try {
    while (!outcome) {
      await checkpoint();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (outcome.code !== 0) throw new Error(`Staged source SQLite ${mode} failed: ${outcome.reason || `exit ${outcome.code}`}`);
    if (stdout.trim() !== "ok") throw new Error(`Staged source failed SQLite ${mode}: ${stdout.trim() || "no result"}`);
  } finally {
    if (!outcome) { child.kill("SIGKILL"); await ended; }
  }
}
