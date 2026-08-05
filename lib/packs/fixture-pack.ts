import type { GenerateRoutesRequestV1, GenerateRoutesResponseV1 } from "@/lib/contracts";
import type { FeatureCollection, LineString } from "geojson";
import type { AreaGeometry } from "@/lib/graph";
import fixtureGraph from "@/data/fixtures/graph/tiny.json";

type Bounds = GenerateRoutesRequestV1["bbox"];

export const FIXTURE_PACK_METADATA = {
  id: "fixture-pack",
  schemaVersion: "1",
  dataVersion: "fixture-v1",
  builtAt: "2026-08-04T00:00:00Z",
} satisfies GenerateRoutesResponseV1["pack"];

export const FIXTURE_PACK_COVERAGE: Bounds = [-122.19, 37.15, -122.13, 37.18];
export const FIXTURE_PACK_COVERAGE_GEOMETRY: AreaGeometry = {
  type: "Polygon",
  coordinates: [[
    [FIXTURE_PACK_COVERAGE[0], FIXTURE_PACK_COVERAGE[1]],
    [FIXTURE_PACK_COVERAGE[2], FIXTURE_PACK_COVERAGE[1]],
    [FIXTURE_PACK_COVERAGE[2], FIXTURE_PACK_COVERAGE[3]],
    [FIXTURE_PACK_COVERAGE[0], FIXTURE_PACK_COVERAGE[3]],
    [FIXTURE_PACK_COVERAGE[0], FIXTURE_PACK_COVERAGE[1]],
  ]],
};

// Inset from the pack edge so a first-time local demo reliably contains the
// committed fixture graph and remains comfortably within the area budget.
export const FIXTURE_PACK_DEMO_BOUNDS: Bounds = [-122.183, 37.155, -122.14, 37.178];

export const FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS = 25;

export type BuilderPackConfig = {
  id: string;
  name: string;
  subtitle: string;
  dataVersion: string;
  builtAt: string;
  coverageBbox: Bounds;
  coverage: AreaGeometry;
  suggestedBounds: Bounds;
  display: { center: [number, number]; zoom: number };
  trailNetwork: FeatureCollection<LineString>;
};

const fixtureNodes = new Map(fixtureGraph.nodes.map((node) => [node.id, node]));
type FixtureTrailTuple = [string, string, string, Array<[number, number]>?, string?];
const fixtureTrails = fixtureGraph.undirectedTrails as unknown as FixtureTrailTuple[];
const mappedTrails = fixtureTrails.filter((trail) => trail[4]?.startsWith("openstreetmap:"));

export const FIXTURE_PACK_TRAIL_NETWORK: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: mappedTrails.map((trail, index) => {
    const [fromNodeId, toNodeId, trailName, segmentCoordinates, sourceId] = trail;
    const from = fixtureNodes.get(fromNodeId);
    const to = fixtureNodes.get(toNodeId);
    if (!from || !to) throw new Error(`Fixture trail ${index} references a missing node`);
    const coordinates = segmentCoordinates ?? [[from.lon, from.lat], [to.lon, to.lat]];
    return {
      type: "Feature",
      properties: { id: `mapped-trail-${index}`, name: trailName, role: "available-trail", sourceId },
      geometry: {
        type: "LineString",
        coordinates: coordinates.map(([lon, lat]) => [lon, lat]),
      },
    };
  }),
};

export const FIXTURE_BUILDER_PACK: BuilderPackConfig = {
  id: FIXTURE_PACK_METADATA.id,
  name: "Fixture pack",
  subtitle: "Santa Cruz Mountains preview",
  dataVersion: FIXTURE_PACK_METADATA.dataVersion,
  builtAt: FIXTURE_PACK_METADATA.builtAt,
  coverageBbox: FIXTURE_PACK_COVERAGE,
  coverage: FIXTURE_PACK_COVERAGE_GEOMETRY,
  suggestedBounds: FIXTURE_PACK_DEMO_BOUNDS,
  display: { center: [-122.16, 37.165], zoom: 12.4 },
  trailNetwork: FIXTURE_PACK_TRAIL_NETWORK,
};
