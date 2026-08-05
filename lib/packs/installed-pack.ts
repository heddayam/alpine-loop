import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { packManifestSchema, type PackManifest } from "@/lib/contracts";

const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type CurrentPointer = {
  dataVersion: string;
  path: string;
};

export type InstalledPack = {
  root: string;
  directory: string;
  manifestPath: string;
  databasePath: string;
  manifest: PackManifest;
};

export function localPackRoot(): string {
  return path.resolve(process.env.ALPINE_PACK_ROOT ?? ".local-data/packs");
}

function parseCurrentPointer(value: unknown): CurrentPointer {
  if (!value || typeof value !== "object") throw new Error("Pack current pointer must be an object");
  const pointer = value as Record<string, unknown>;
  if (typeof pointer.dataVersion !== "string" || pointer.dataVersion.length === 0) {
    throw new Error("Pack current pointer is missing dataVersion");
  }
  if (typeof pointer.path !== "string" || pointer.path.length === 0 || path.isAbsolute(pointer.path)) {
    throw new Error("Pack current pointer must contain a relative manifest path");
  }
  return { dataVersion: pointer.dataVersion, path: pointer.path };
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pack current pointer leaves the configured pack root");
  }
}

export async function loadInstalledPack(
  packId: string,
  root = localPackRoot(),
): Promise<InstalledPack | null> {
  if (!PACK_ID.test(packId)) throw new Error(`Invalid pack id: ${packId}`);
  const packRoot = path.join(root, packId);
  let pointer: CurrentPointer;
  try {
    pointer = parseCurrentPointer(JSON.parse(await readFile(path.join(packRoot, "current.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const manifestPath = path.resolve(packRoot, pointer.path);
  assertInside(packRoot, manifestPath);
  const manifest = packManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.id !== packId) throw new Error(`Installed manifest id ${manifest.id} does not match ${packId}`);
  if (manifest.dataVersion !== pointer.dataVersion) {
    throw new Error(`Installed manifest version ${manifest.dataVersion} does not match current pointer ${pointer.dataVersion}`);
  }

  const directory = path.dirname(manifestPath);
  const databasePath = path.join(directory, "pack.sqlite");
  await access(databasePath, constants.R_OK);
  const resolvedRoot = await realpath(root);
  const resolvedDirectory = await realpath(directory);
  assertInside(resolvedRoot, resolvedDirectory);
  return { root: resolvedRoot, directory: resolvedDirectory, manifestPath, databasePath, manifest };
}

export async function loadSantaCruzPack(root = localPackRoot()): Promise<InstalledPack | null> {
  return loadInstalledPack("santa-cruz-mountains", root);
}
