import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function withAtomicDirectory<T>(
  destination: string,
  build: (stagingDirectory: string) => Promise<T>,
): Promise<T> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.staging-${path.basename(destination)}-${randomUUID()}`);
  await mkdir(staging);
  try {
    const result = await build(staging);
    await rename(staging, destination);
    return result;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
