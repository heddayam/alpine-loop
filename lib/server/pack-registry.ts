import fixtureGraph from "@/data/fixtures/graph/tiny.json";
import { getNamedArea, getSearchRegion, listSearchRegions, searchNamedAreas } from "@/lib/data/named-area-catalog";
import {
  FixtureGraphRepository,
  SQLiteClosedRouteFeasibilityRepository,
  SQLiteGraphRepository,
  type FixtureGraphData,
} from "@/lib/graph";
import {
  FIXTURE_PACK_COVERAGE,
  FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
  FIXTURE_PACK_METADATA,
} from "@/lib/packs/fixture-pack";
import { localPackRoot, type InstalledPack } from "@/lib/packs/installed-pack";
import { discoverCatalogPacks } from "@/lib/packs/pack-catalog";
import type { ClosedRoutePack } from "./closed-route-generation";

export const INSTALLED_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS = 100;

export type RegisteredRoutePack = ClosedRoutePack & {
  kind: "fixture" | "installed";
  sourceFreshness: string;
  sourceConfidence: "high" | "medium" | "low";
  fallbackSourceIds: string[];
};

// The legacy fixture intentionally has no schema-3 feasibility repository.
// The V3 endpoint reports CLOSED_ROUTES_UNAVAILABLE until a compact fixture is compiled.
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

function registeredInstalledPack(installed: InstalledPack): RegisteredRoutePack {
  const manifest = installed.manifest;
  return {
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
    ...(manifest.capabilities.namedAreas ? {
      searchNamedAreas: (text: string, limit?: number) => searchNamedAreas(installed.databasePath, text, limit),
      getNamedArea: (id: string) => getNamedArea(installed.databasePath, id),
    } : {}),
    ...(manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6" ? {
      listSearchRegions: () => listSearchRegions(installed.databasePath),
      getSearchRegion: (id: string) => getSearchRegion(installed.databasePath, id),
    } : {}),
    ...(manifest.schemaVersion === "3" || manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6" ? {
      closedRouteRuntimeMode: manifest.closedRouteTopology.runtimeMode,
      ...(manifest.closedRouteTopology.runtimeMode === "reachable-graph-fallback" ? {
        loadClosedRouteFeasibilityRepository: async (signal: AbortSignal) => {
          if (signal.aborted) throw signal.reason ?? new DOMException("Pack opening was cancelled", "AbortError");
          return new SQLiteClosedRouteFeasibilityRepository({
            databasePath: installed.databasePath,
            manifest,
          });
        },
      } : {}),
    } : {}),
    maximumAreaSquareKilometers: INSTALLED_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
    loadRepository: async (signal) => {
      if (signal.aborted) throw signal.reason ?? new DOMException("Pack opening was cancelled", "AbortError");
      return new SQLiteGraphRepository(installed.databasePath, manifest.id);
    },
  };
}

export async function loadRoutePacks(
  root = localPackRoot(),
): Promise<ReadonlyMap<string, RegisteredRoutePack>> {
  const { installedPacks } = await discoverCatalogPacks(root);
  if (installedPacks.size === 0) {
    return new Map([[FIXTURE_PACK.id, FIXTURE_PACK]]);
  }
  return new Map(
    [...installedPacks.values()].map((installed) => [installed.manifest.id, registeredInstalledPack(installed)]),
  );
}
