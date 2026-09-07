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
  return path.resolve(/* turbopackIgnore: true */ process.env.ALPINE_PACK_ROOT ?? ".local-data/packs");
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

function currentManifest(value: unknown): PackManifest {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion !== "6") {
    throw new Error(`Unsupported pack schema ${String(value.schemaVersion)}. Rebuild this pack with the current compiler.`);
  }
  if (value && typeof value === "object" && "closedRouteTopology" in value) {
    const topology = value.closedRouteTopology;
    if (topology && typeof topology === "object" && "runtimeMode" in topology && topology.runtimeMode !== "reachable-graph-fallback") {
      throw new Error(`Unsupported pack runtime ${String(topology.runtimeMode)}. Rebuild this pack with the current compiler.`);
    }
  }
  return packManifestSchema.parse(value);
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
  const manifest = currentManifest(JSON.parse(await readFile(manifestPath, "utf8")));
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

export async function loadInstalledPackVersion(
  packId: string,
  dataVersion: string,
  root = localPackRoot(),
): Promise<InstalledPack | null> {
  if (!PACK_ID.test(packId)) throw new Error(`Invalid pack id: ${packId}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(dataVersion)) {
    throw new Error(`Invalid pack data version: ${dataVersion}`);
  }
  const packRoot = path.join(root, packId);
  const directory = path.resolve(packRoot, dataVersion);
  assertInside(packRoot, directory);
  const manifestPath = path.join(directory, "manifest.json");
  let manifest: PackManifest;
  try {
    manifest = currentManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (manifest.id !== packId || manifest.dataVersion !== dataVersion) {
    throw new Error(`Installed pack version identity does not match ${packId}/${dataVersion}`);
  }
  const databasePath = path.join(directory, "pack.sqlite");
  await access(databasePath, constants.R_OK);
  const resolvedRoot = await realpath(root);
  const resolvedDirectory = await realpath(directory);
  assertInside(resolvedRoot, resolvedDirectory);
  return { root: resolvedRoot, directory: resolvedDirectory, manifestPath, databasePath, manifest };
}
