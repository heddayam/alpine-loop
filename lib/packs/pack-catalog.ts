import registryJson from "@/data/regions/registry.json";
import { regionRegistryV1Schema } from "@/lib/contracts/regions";
import { loadInstalledPack, localPackRoot, type InstalledPack } from "./installed-pack";

/** Discover valid linked installations in display order. Direct loading remains strict. */
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
  return new Map(installations.flatMap((pack) => pack ? [[pack.manifest.id, pack] as const] : []));
}
