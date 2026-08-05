import type { BuilderPackConfig } from "./fixture-pack";
import { FIXTURE_BUILDER_PACK } from "./fixture-pack";
import { loadSantaCruzPack } from "./installed-pack";

function insetBounds(
  [west, south, east, north]: BuilderPackConfig["coverage"],
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

export async function loadBuilderPack(): Promise<BuilderPackConfig> {
  const installed = await loadSantaCruzPack();
  if (!installed) return FIXTURE_BUILDER_PACK;
  const manifest = installed.manifest;
  return {
    id: manifest.id,
    name: manifest.name,
    subtitle: `Data ${manifest.dataVersion}`,
    dataVersion: manifest.dataVersion,
    builtAt: manifest.builtAt,
    coverage: manifest.coverage.bbox,
    suggestedBounds: insetBounds(manifest.coverage.bbox, manifest.display.center),
    display: manifest.display,
    trailNetwork: { type: "FeatureCollection", features: [] },
  };
}
