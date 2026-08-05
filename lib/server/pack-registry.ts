import fixtureGraph from "@/data/fixtures/graph/tiny.json";
import { getNamedArea, searchNamedAreas } from "@/lib/data/named-area-catalog";
import { FixtureGraphRepository, SQLiteGraphRepository, type FixtureGraphData } from "@/lib/graph";
import {
  FIXTURE_PACK_COVERAGE,
  FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
  FIXTURE_PACK_METADATA,
} from "@/lib/packs/fixture-pack";
import { loadSantaCruzPack } from "@/lib/packs/installed-pack";
import type { RoutePack } from "./route-generation";

export const INSTALLED_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS = 100;

export type RegisteredRoutePack = RoutePack & {
  kind: "fixture" | "installed";
  sourceFreshness: string;
  sourceConfidence: "high" | "medium" | "low";
  fallbackSourceIds: string[];
};

const FIXTURE_PACK: RegisteredRoutePack = {
  ...FIXTURE_PACK_METADATA,
  kind: "fixture",
  sourceFreshness: FIXTURE_PACK_METADATA.builtAt,
  sourceConfidence: "high",
  fallbackSourceIds: ["fixture-source"],
  coverageBbox: FIXTURE_PACK_COVERAGE,
  coverage: {
    type: "Polygon",
    coordinates: [[
      [FIXTURE_PACK_COVERAGE[0], FIXTURE_PACK_COVERAGE[1]],
      [FIXTURE_PACK_COVERAGE[2], FIXTURE_PACK_COVERAGE[1]],
      [FIXTURE_PACK_COVERAGE[2], FIXTURE_PACK_COVERAGE[3]],
      [FIXTURE_PACK_COVERAGE[0], FIXTURE_PACK_COVERAGE[3]],
      [FIXTURE_PACK_COVERAGE[0], FIXTURE_PACK_COVERAGE[1]],
    ]],
  },
  maximumAreaSquareKilometers: FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
  loadRepository: async () =>
    new FixtureGraphRepository(fixtureGraph as unknown as FixtureGraphData),
};

export async function loadRoutePacks(): Promise<ReadonlyMap<string, RegisteredRoutePack>> {
  const packs = new Map<string, RegisteredRoutePack>([[FIXTURE_PACK.id, FIXTURE_PACK]]);
  const installed = await loadSantaCruzPack();
  if (installed) {
    const manifest = installed.manifest;
    packs.set(manifest.id, {
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      dataVersion: manifest.dataVersion,
      builtAt: manifest.builtAt,
      kind: "installed",
      sourceFreshness: manifest.sources.map(({ retrievedAt }) => retrievedAt).sort()[0] ?? manifest.builtAt,
      sourceConfidence: manifest.fieldConfidence.access ?? "low",
      fallbackSourceIds: manifest.sources.map(({ id }) => id),
      coverageBbox: manifest.coverage.bbox,
      coverage: manifest.coverage.boundary,
      databasePath: installed.databasePath,
      ...(manifest.schemaVersion === "2" && manifest.capabilities.namedAreas ? {
        searchNamedAreas: (text: string, limit?: number) => searchNamedAreas(installed.databasePath, text, limit),
        getNamedArea: (id: string) => getNamedArea(installed.databasePath, id),
      } : {}),
      maximumAreaSquareKilometers: INSTALLED_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
      loadRepository: async (signal) => {
        if (signal.aborted) throw signal.reason ?? new DOMException("Pack opening was cancelled", "AbortError");
        return new SQLiteGraphRepository(installed.databasePath, manifest.id);
      },
    });
  }
  return packs;
}
