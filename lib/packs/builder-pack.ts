import type { BuilderPackConfig } from "./fixture-pack";
import { FIXTURE_BUILDER_PACK } from "./fixture-pack";
import { localPackRoot } from "./installed-pack";
import { discoverCatalogPacks } from "./pack-catalog";

function insetBounds(
  [west, south, east, north]: BuilderPackConfig["coverageBbox"],
  [centerLon, centerLat]: BuilderPackConfig["display"]["center"],
): BuilderPackConfig["suggestedBounds"] {
  const longitudeRadius = Math.min(0.015, (east - west) / 2);
  const latitudeRadius = Math.min(0.014, (north - south) / 2);
  return [
    Math.max(west, centerLon - longitudeRadius),
    Math.max(south, centerLat - latitudeRadius),
    Math.min(east, centerLon + longitudeRadius),
    Math.min(north, centerLat + latitudeRadius),
  ];
}

export async function loadBuilderPack(
  packId?: string,
  root = localPackRoot(),
): Promise<BuilderPackConfig> {
  const { installedPacks } = await discoverCatalogPacks(root);
  const installed = (packId ? installedPacks.get(packId) : undefined)
    ?? installedPacks.values().next().value;
  if (!installed) return FIXTURE_BUILDER_PACK;
  const manifest = installed.manifest;
  return {
    id: manifest.id,
    name: manifest.name,
    subtitle: `Data ${manifest.dataVersion}`,
    dataVersion: manifest.dataVersion,
    builtAt: manifest.builtAt,
    coverageBbox: manifest.coverage.bbox,
    coverage: manifest.coverage.boundary,
    suggestedBounds: insetBounds(manifest.coverage.bbox, manifest.display.center),
    display: manifest.display,
    trailNetwork: { type: "FeatureCollection", features: [] },
  };
}
