import path from "node:path";
import type { SourceSnapshot } from "./adapters";
import type { CompilePackOptions, PackSeed } from "./compiler";
import { FixtureElevationSampler } from "./fixture-elevation-sampler";
import { FixtureNamedAreaAdapter } from "./fixture-named-area-adapter";
import { FixtureOfficialAccessAdapter } from "./fixture-official-access-adapter";
import { FixtureTopologyAdapter } from "./fixture-topology-adapter";
import { sha256File } from "./file-source";

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
  schemaVersion: "1",
  id: "fixture-pack",
  name: "Compiler Fixture Pack",
  dataVersion: "fixture-v1",
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
  capabilities: { elevation: true, officialAccess: true },
  fieldConfidence: { topology: "high", access: "medium", elevation: "high" },
};

export const fixturePackSeedV2: PackSeed = {
  ...fixturePackSeed,
  schemaVersion: "2",
  dataVersion: "fixture-v2",
  capabilities: { ...fixturePackSeed.capabilities, namedAreas: true },
};

export const fixturePackSeedV3: PackSeed = {
  ...fixturePackSeedV2,
  schemaVersion: "3",
  dataVersion: "fixture-v3",
  capabilities: { ...fixturePackSeedV2.capabilities, closedRouteTopology: true },
  closedRouteTopology: {
    algorithmVersion: "closed-route-topology-v1",
    policyVersion: "closed-route-decision-graph-v1",
    profiles: ["known", "inclusive"],
  },
};

export async function fixtureCompileOptions(
  outputRoot: string,
  fixtureRoot = path.resolve("data/fixtures/source"),
  overrides: Partial<Pick<CompilePackOptions, "builtAt" | "seed" | "beforePublish">> = {},
): Promise<CompilePackOptions> {
  const topology = await fixtureSnapshot(fixtureRoot, "topology.json", {
    id: "fixture-topology",
    authority: "Alpine Search",
    dataset: "Synthetic OSM-like topology",
    version: "1",
    url: "https://example.invalid/alpine-search/fixture-topology",
    license: "CC0-1.0",
  });
  const officialAccess = await fixtureSnapshot(fixtureRoot, "official-access.json", {
    id: "fixture-official-access",
    authority: "Alpine Search",
    dataset: "Synthetic official access overlay",
    version: "1",
    url: "https://example.invalid/alpine-search/fixture-official-access",
    license: "CC0-1.0",
  });
  const elevation = await fixtureSnapshot(fixtureRoot, "elevation.json", {
    id: "fixture-elevation",
    authority: "Alpine Search",
    dataset: "Synthetic elevation samples",
    version: "1",
    url: "https://example.invalid/alpine-search/fixture-elevation",
    license: "CC0-1.0",
  });
  return {
    outputRoot,
    seed: overrides.seed ?? fixturePackSeed,
    builtAt: overrides.builtAt ?? RETRIEVED_AT,
    topology: { adapter: new FixtureTopologyAdapter(), snapshot: topology },
    officialAccess: { adapter: new FixtureOfficialAccessAdapter(), snapshot: officialAccess },
    elevation: { sampler: await FixtureElevationSampler.create(elevation), snapshot: elevation },
    beforePublish: overrides.beforePublish,
  };
}

export async function fixtureCompileOptionsV2(
  outputRoot: string,
  fixtureRoot = path.resolve("data/fixtures/source"),
  namedAreaFixtureRoot = path.resolve("data/fixtures/named-areas"),
  overrides: Partial<Pick<CompilePackOptions, "builtAt" | "seed" | "beforePublish">> = {},
): Promise<CompilePackOptions> {
  const base = await fixtureCompileOptions(outputRoot, fixtureRoot, {
    ...overrides,
    seed: overrides.seed ?? fixturePackSeedV2,
  });
  const namedAreas = await fixtureSnapshot(namedAreaFixtureRoot, "areas.json", {
    id: "fixture-named-areas",
    authority: "Alpine Search",
    dataset: "Synthetic OSM named areas",
    version: "1",
    url: "https://example.invalid/alpine-search/fixture-named-areas",
    license: "CC0-1.0",
  });
  return {
    ...base,
    namedAreas: { adapter: new FixtureNamedAreaAdapter(), snapshot: namedAreas },
  };
}

export async function fixtureCompileOptionsV3(
  outputRoot: string,
  fixtureRoot = path.resolve("data/fixtures/source"),
  namedAreaFixtureRoot = path.resolve("data/fixtures/named-areas"),
  overrides: Partial<Pick<CompilePackOptions, "builtAt" | "seed" | "beforePublish">> = {},
): Promise<CompilePackOptions> {
  return fixtureCompileOptionsV2(outputRoot, fixtureRoot, namedAreaFixtureRoot, {
    ...overrides,
    seed: overrides.seed ?? fixturePackSeedV3,
  });
}
