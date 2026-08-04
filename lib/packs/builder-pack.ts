import type { BuilderPackConfig } from "./fixture-pack";
import { FIXTURE_BUILDER_PACK } from "./fixture-pack";
import { loadSantaCruzPack } from "./installed-pack";

function insetBounds(
  [west, south, east, north]: BuilderPackConfig["coverage"],
): BuilderPackConfig["suggestedBounds"] {
  const longitudeInset = (east - west) * 0.28;
  const latitudeInset = (north - south) * 0.28;
  return [west + longitudeInset, south + latitudeInset, east - longitudeInset, north - latitudeInset];
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
    suggestedBounds: insetBounds(manifest.coverage.bbox),
    trailNetwork: { type: "FeatureCollection", features: [] },
  };
}
