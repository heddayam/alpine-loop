import registryJson from "@/data/regions/registry.json";
import {
  packCatalogResponseV1Schema,
  regionRegistryV1Schema,
  type AvailableRegionPack,
  type PackCatalogRegionV1,
  type PackCatalogResponseV1,
} from "@/lib/contracts/regions";
import { loadInstalledPack, localPackRoot, type InstalledPack } from "./installed-pack";

export type CatalogPackDiscovery = {
  catalog: PackCatalogResponseV1;
  installedPacks: ReadonlyMap<string, InstalledPack>;
};

function catalogMetadata(installed: InstalledPack): AvailableRegionPack {
  const { manifest } = installed;
  return {
    id: manifest.id,
    name: manifest.name,
    dataVersion: manifest.dataVersion,
    builtAt: manifest.builtAt,
    coverageBbox: manifest.coverage.bbox,
    coverage: manifest.coverage.boundary,
    display: manifest.display,
  };
}

/**
 * Resolves only packs explicitly linked by the committed region registry.
 * A bad local installation is represented as unavailable here; callers that
 * need strict validation should use loadInstalledPack directly.
 */
export async function discoverCatalogPacks(root = localPackRoot()): Promise<CatalogPackDiscovery> {
  const registry = regionRegistryV1Schema.parse(registryJson);
  const installedPacks = new Map<string, InstalledPack>();
  const resolutions = await Promise.all(
    [...registry.regions]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map(async (region) => {
        const base = { id: region.id, label: region.label, displayOrder: region.displayOrder };
        if (!region.packId) {
          return { region: { ...base, state: "planned" as const } };
        }

        try {
          const installed = await loadInstalledPack(region.packId, root);
          if (!installed) {
            return { region: { ...base, state: "unavailable" as const, packId: region.packId } };
          }
          return {
            installed,
            region: {
              ...base,
              state: "available" as const,
              packId: region.packId,
              pack: catalogMetadata(installed),
            },
          };
        } catch {
          return { region: { ...base, state: "unavailable" as const, packId: region.packId } };
        }
      }),
  );
  for (const resolution of resolutions) {
    if (resolution.installed) installedPacks.set(resolution.installed.manifest.id, resolution.installed);
  }
  const regions = resolutions.map(({ region }) => region as PackCatalogRegionV1);

  return {
    catalog: packCatalogResponseV1Schema.parse({ version: 1, regions }),
    installedPacks,
  };
}

export async function loadPackCatalog(root = localPackRoot()): Promise<PackCatalogResponseV1> {
  return (await discoverCatalogPacks(root)).catalog;
}
