import { DatabaseSync } from "node:sqlite";
import polygonClipping from "polygon-clipping";
import registryJson from "@/data/regions/registry.json";
import { regionRegistryV1Schema } from "@/lib/contracts/regions";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { loadInstalledPack, localPackRoot, type InstalledPack } from "./installed-pack";

const LOCAL_COVERAGE_PACK_ID = "local-coverage";
type MultiPolygon = Parameters<typeof polygonClipping.difference>[0];
const asMulti = (geometry: AreaGeometry): MultiPolygon =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as MultiPolygon;

const migrationReviews = new Map<string, boolean>();

/** Only OSM source identities are rebuilt today; supplemental routing needs explicit migration review. */
export function legacyRoutingNeedsReview(pack: InstalledPack): boolean {
  const key = pack.databasePath;
  const cached = migrationReviews.get(key);
  if (cached !== undefined) return cached;
  let needsReview = true;
  try {
    const database = new DatabaseSync(pack.databasePath, { readOnly: true });
    try {
      // Both probes use the edge primary-key index. Unknown source identities
      // remain installed; listing sources in both manifests proves no replacement.
      needsReview = Boolean(database.prepare("SELECT id FROM edges WHERE id < 'osm-way-' LIMIT 1").get()
        ?? database.prepare("SELECT id FROM edges WHERE id >= 'osm-way.' LIMIT 1").get());
    } finally { database.close(); }
  } catch { /* Unreadable provenance cannot authorize retiring an installation. */ }
  if (migrationReviews.size >= 128) migrationReviews.delete(migrationReviews.keys().next().value!);
  migrationReviews.set(key, needsReview);
  return needsReview;
}

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

/** Retire only exactly covered OSM packs; supplemental source routing requires migration review. */
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
  const entries = installations.flatMap((pack) => pack && (!local || !fullyCovered(pack, local) || legacyRoutingNeedsReview(pack))
    ? [[pack.manifest.id, pack] as const] : []);
  if (local) entries.push([local.manifest.id, local]);
  return new Map(entries);
}
