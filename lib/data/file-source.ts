import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SourceSnapshot } from "./adapters";

export async function sha256File(path: string): Promise<`sha256:${string}`> {
  const contents = await readFile(path);
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

export async function readValidatedSnapshot(snapshot: SourceSnapshot): Promise<unknown> {
  if (!snapshot.license.trim()) {
    throw new Error(`Source ${snapshot.id} has no license decision`);
  }
  const actualHash = await sha256File(snapshot.localPath);
  if (actualHash !== snapshot.contentHash) {
    throw new Error(`Content hash mismatch for source ${snapshot.id}`);
  }
  const source = await readFile(snapshot.localPath, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Source ${snapshot.id} is not valid JSON`, { cause: error });
  }
}
