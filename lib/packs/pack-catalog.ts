import polygonClipping from "polygon-clipping";
import registryJson from "@/data/regions/registry.json";
import { regionRegistryV1Schema } from "@/lib/contracts/regions";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { loadInstalledPack, localPackRoot, type InstalledPack } from "./installed-pack";

const LOCAL_COVERAGE_PACK_ID = "local-coverage";
type MultiPolygon = Parameters<typeof polygonClipping.difference>[0];
const asMulti = (geometry: AreaGeometry): MultiPolygon =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as MultiPolygon;

function fullyCovered(legacy: InstalledPack, local: InstalledPack): boolean {
  try {
    return polygonClipping.difference(
      asMulti(legacy.manifest.coverage.boundary), asMulti(local.manifest.coverage.boundary),
    ).length === 0;
  } catch {
    // A malformed boundary must not remove a working legacy installation.
    return false;
  }
}

/** Keep a legacy pack until its entire exact geometry exists in the installed local snapshot. */
export async function discoverCatalogPacks(root = localPackRoot()): Promise<ReadonlyMap<string, InstalledPack>> {
  const registry = regionRegistryV1Schema.parse(registryJson);
  const installations = await Promise.all(
    [...registry.regions]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map(async ({ packId }) => {
        if (!packId) return null;
        try { return await loadInstalledPack(packId, root); }
        catch { return null; }
      }),
  );
  let local: InstalledPack | null;
  try { local = await loadInstalledPack(LOCAL_COVERAGE_PACK_ID, root); }
  catch { local = null; }
  const entries = installations.flatMap((pack) => pack && (!local || !fullyCovered(pack, local))
    ? [[pack.manifest.id, pack] as const] : []);
  if (local) entries.push([local.manifest.id, local]);
  return new Map(entries);
}
