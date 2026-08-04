import { describe, expect, it } from "vitest";
import type { GeneratedRoute } from "@/lib/contracts";
import { routeFeatures } from "./HikeMap";

function route(id: string, longitude: number): GeneratedRoute {
  return {
    id,
    shape: "loop",
    geometry: { type: "LineString", coordinates: [[longitude, 37.15], [longitude + 0.01, 37.16], [longitude, 37.15]] },
    startAccessPoint: { id: "start", name: "Start", lon: longitude, lat: 37.15, accessState: "public", confidence: "high" },
    endAccessPoint: { id: "start", name: "Start", lon: longitude, lat: 37.15, accessState: "public", confidence: "high" },
    distanceMeters: 1000,
    elevationGainMeters: 100,
    elevationLossMeters: 100,
    minimumElevationMeters: 200,
    maximumElevationMeters: 300,
    steepestSustainedGradePct: 5,
    repeatedEdgeFraction: 0,
    trailNames: ["Fixture Trail"],
    warnings: [],
    source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["fixture"] },
  };
}

describe("generated route map features", () => {
  it("preserves all contract geometries and marks exactly one selected route for non-color styling", () => {
    const routes = [route("first", -122.18), route("second", -122.16)];
    const features = routeFeatures(routes, "second");

    expect(features.features).toHaveLength(2);
    expect(features.features[0]?.geometry).toEqual(routes[0]?.geometry);
    expect(features.features[0]?.properties).toMatchObject({ id: "first", selected: false, routeNumber: 1 });
    expect(features.features[1]?.geometry).toEqual(routes[1]?.geometry);
    expect(features.features[1]?.properties).toMatchObject({ id: "second", selected: true, routeNumber: 2 });
  });
});
