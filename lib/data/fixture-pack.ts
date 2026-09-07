import path from "node:path";
import type { SourceSnapshot } from "./adapters";
import type { CompilePackOptions, PackSeed } from "./compiler";
import { FixtureElevationSampler } from "./fixture-elevation-sampler";
import { FixtureNamedAreaAdapter } from "./fixture-named-area-adapter";
import { FixtureOfficialAccessAdapter } from "./fixture-official-access-adapter";
import { FixtureTopologyAdapter } from "./fixture-topology-adapter";
import { sha256File } from "./file-source";
import { readSearchRegionInput } from "./search-regions";
import type { NormalizedTopology } from "./types";

const RETRIEVED_AT = "2026-08-04T00:00:00Z";

async function fixtureSnapshot(
  fixtureRoot: string,
  filename: string,
  details: Omit<SourceSnapshot, "localPath" | "contentHash" | "retrievedAt">,
): Promise<SourceSnapshot> {
  const localPath = path.join(fixtureRoot, filename);
  return { ...details, retrievedAt: RETRIEVED_AT, localPath, contentHash: await sha256File(localPath) };
}

export const fixturePackSeed: PackSeed = {
  schemaVersion: "6",
  id: "fixture-pack",
  name: "Compiler Fixture Pack",
  dataVersion: "fixture-v6",
  compilerVersion: "fixture-compiler-v1",
  coverage: {
    bbox: [-122.161, 37.159, -122.155, 37.162],
    boundary: {
      type: "Polygon",
      coordinates: [[
        [-122.161, 37.159], [-122.155, 37.159], [-122.155, 37.162],
        [-122.161, 37.162], [-122.161, 37.159],
      ]],
    },
  },
  display: { center: [-122.158, 37.1605], zoom: 14 },
  capabilities: { elevation: true, officialAccess: true, namedAreas: true, closedRouteTopology: true, batchSearchRegions: true, elevationProfiles: true, portalAccessPoints: true },
  fieldConfidence: { topology: "high", access: "medium", elevation: "high" },
  closedRouteTopology: {
    runtimeMode: "reachable-graph-fallback",
    algorithmVersion: "closed-route-topology-v1",
    policyVersion: "closed-route-decision-graph-v1",
    profiles: ["known", "inclusive"],
  },
};

export async function fixtureCompileOptions(
  outputRoot: string,
  fixtureRoot = path.resolve("data/fixtures/source"),
  namedAreaFixtureRoot = path.resolve("data/fixtures/named-areas"),
  searchRegionPath = path.resolve("data/fixtures/search-regions.json"),
  overrides: Partial<Pick<CompilePackOptions, "builtAt" | "seed" | "beforePublish" | "searchRegions">> = {},
): Promise<CompilePackOptions> {
  const topology = await fixtureSnapshot(fixtureRoot, "topology.json", {
    id: "fixture-topology",
    authority: "Alpine Loop",
    dataset: "Synthetic OSM-like topology",
    version: "1",
    url: "https://example.invalid/alpine-loop/fixture-topology",
    license: "CC0-1.0",
  });
  const officialAccess = await fixtureSnapshot(fixtureRoot, "official-access.json", {
    id: "fixture-official-access",
    authority: "Alpine Loop",
    dataset: "Synthetic official access overlay",
    version: "1",
    url: "https://example.invalid/alpine-loop/fixture-official-access",
    license: "CC0-1.0",
  });
  const elevation = await fixtureSnapshot(fixtureRoot, "elevation.json", {
    id: "fixture-elevation",
    authority: "Alpine Loop",
    dataset: "Synthetic elevation samples",
    version: "1",
    url: "https://example.invalid/alpine-loop/fixture-elevation",
    license: "CC0-1.0",
  });
  const normalized: NormalizedTopology[] = [];
  for await (const data of new FixtureTopologyAdapter().normalize(topology)) normalized.push(data);
  if (normalized.length !== 1) throw new Error("Fixture topology adapter must produce exactly one graph");
  const namedAreas = await fixtureSnapshot(namedAreaFixtureRoot, "areas.json", {
    id: "fixture-named-areas",
    authority: "Alpine Loop",
    dataset: "Synthetic OSM named areas",
    version: "1",
    url: "https://example.invalid/alpine-loop/fixture-named-areas",
    license: "CC0-1.0",
  });
  const portalTopology = {
    ...normalized[0]!,
    ways: normalized[0]!.ways.map((way) => ({ ...way, edgeClass: "trail" as const })),
    accessPoints: normalized[0]!.accessPoints.map((point, index) => ({
      ...point,
      kind: "trailhead" as const,
      reachableTrailKm: 5 + index,
      trailComponentId: `fixture-component-${index + 1}`,
      portalRoadClass: "street" as const,
      parkingDistanceM: index === 0 ? 25 : null,
    })),
  };
  return {
    outputRoot,
    seed: overrides.seed ?? fixturePackSeed,
    builtAt: overrides.builtAt ?? RETRIEVED_AT,
    topology: { data: portalTopology, snapshot: topology },
    officialAccess: { adapter: new FixtureOfficialAccessAdapter(), snapshot: officialAccess },
    // The fixture region is synthetic and has no buildings.
    buildings: [],
    elevation: { sampler: await FixtureElevationSampler.create(elevation), snapshot: elevation },
    namedAreas: { adapter: new FixtureNamedAreaAdapter(), snapshot: namedAreas },
    searchRegions: overrides.searchRegions ?? await readSearchRegionInput(searchRegionPath),
    beforePublish: overrides.beforePublish,
  };
}

export const fixtureCompileOptionsV6 = fixtureCompileOptions;
