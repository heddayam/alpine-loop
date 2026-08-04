import { describe, expect, it } from "vitest";
import type { GeneratedRoute } from "@/lib/contracts";
import { projectedRouteTraces } from "./routeTraceOverlay";

function route(id: string, coordinates: Array<[number, number]>): GeneratedRoute {
  return {
    id,
    shape: "loop",
    geometry: { type: "LineString", coordinates },
    startAccessPoint: { id: `${id}-start`, name: "Trailhead", lon: coordinates[0]?.[0] ?? 0, lat: coordinates[0]?.[1] ?? 0, accessState: "public", confidence: "high" },
    endAccessPoint: { id: `${id}-start`, name: "Trailhead", lon: coordinates[0]?.[0] ?? 0, lat: coordinates[0]?.[1] ?? 0, accessState: "public", confidence: "high" },
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

describe("projected route traces", () => {
  it("projects every route coordinate into one screen-space path", () => {
    const traces = projectedRouteTraces(
      [route("one", [[-122.2, 37.1], [-122.1, 37.2], [-122.2, 37.1]])],
      "one",
      undefined,
      ([lon, lat]) => ({ x: (lon + 123) * 100, y: (38 - lat) * 100 }),
    );

    expect(traces).toEqual([{
      id: "one",
      path: "M80.0 90.0 L90.0 80.0 L80.0 90.0",
      routeNumber: 1,
      selected: true,
      hovered: false,
    }]);
  });

  it("marks hover independently from the persistent selection and ignores unusable lines", () => {
    const traces = projectedRouteTraces(
      [route("selected", [[0, 0], [1, 1]]), route("hovered", [[1, 1], [2, 2]]), route("empty", [[0, 0]])],
      "selected",
      "hovered",
      ([x, y]) => ({ x, y }),
    );

    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({ id: "selected", selected: true, hovered: false });
    expect(traces[1]).toMatchObject({ id: "hovered", selected: false, hovered: true });
  });
});
