import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GeneratedRoute } from "@/lib/contracts";
import {
  HikeMap,
  mapStatusSummary,
  routeFeaturePartitions,
  routeFeatures,
  routeTrailheadPins,
  showCoverageHatching,
} from "./HikeMap";

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
  it("removes the coverage hatch after committing a boundary and restores it for redraw", () => {
    const bounds = [-122.18, 37.155, -122.14, 37.178] as const;

    expect(showCoverageHatching(null, false)).toBe(true);
    expect(showCoverageHatching([...bounds], false)).toBe(false);
    expect(showCoverageHatching([...bounds], true)).toBe(true);
  });

  it("preserves all contract geometries and marks exactly one selected route for non-color styling", () => {
    const routes = [route("first", -122.18), route("second", -122.16)];
    const features = routeFeatures(routes, "second");

    expect(features.features).toHaveLength(2);
    expect(features.features[0]?.geometry).toEqual(routes[0]?.geometry);
    expect(features.features[0]?.properties).toMatchObject({ id: "first", selected: false, routeNumber: 1 });
    expect(features.features[1]?.geometry).toEqual(routes[1]?.geometry);
    expect(features.features[1]?.properties).toMatchObject({ id: "second", selected: true, routeNumber: 2 });
  });

  it("partitions native MapLibre sources without changing geographic coordinates", () => {
    const routes = [route("first", -122.18), route("second", -122.16)];
    const partitions = routeFeaturePartitions(routes, "first", "second");

    expect(partitions.all.features.map(({ properties }) => properties?.id)).toEqual(["first", "second"]);
    expect(partitions.selected.features.map(({ properties }) => properties?.id)).toEqual(["first"]);
    expect(partitions.alternates.features.map(({ properties }) => properties?.id)).toEqual(["second"]);
    expect(partitions.hovered.features.map(({ properties }) => properties?.id)).toEqual(["second"]);
    expect(partitions.selected.features[0]?.geometry).toEqual(routes[0]?.geometry);
    expect(partitions.hovered.features[0]?.geometry).toEqual(routes[1]?.geometry);
  });

  it("creates numbered trailhead pins and emphasizes the selected route pin", () => {
    const routes = [route("first", -122.18), route("second", -122.16)];
    const pins = routeTrailheadPins(routes, "second");

    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({
      coordinates: [-122.18, 37.15],
      routeIds: ["first"],
      routeNumbers: [1],
      numberLabel: "1",
      selected: false,
      nextRouteId: "first",
    });
    expect(pins[1]).toMatchObject({
      coordinates: [-122.16, 37.15],
      routeIds: ["second"],
      routeNumbers: [2],
      numberLabel: "2",
      selected: true,
      nextRouteId: "second",
    });
  });

  it("anchors each pin to the exact first segment coordinate, not separate metadata", () => {
    const mismatched = route("first", -122.18);
    mismatched.startAccessPoint = { ...mismatched.startAccessPoint, lon: -120, lat: 35 };

    expect(routeTrailheadPins([mismatched])[0]?.coordinates).toEqual(mismatched.geometry.coordinates[0]);
  });

  it("groups matches at one physical trailhead and cycles through their result numbers", () => {
    const routes = [route("first", -122.18), route("second", -122.18), route("third", -122.18)];
    const [pin] = routeTrailheadPins(routes, "second");

    expect(pin).toMatchObject({
      routeIds: ["first", "second", "third"],
      routeNumbers: [1, 2, 3],
      numberLabel: "1·2·3",
      selected: true,
      nextRouteId: "third",
    });
  });

  it("compresses a long consecutive run of route numbers on a shared pin", () => {
    const routes = Array.from({ length: 6 }, (_, index) => route(`route-${index + 1}`, -122.18));

    expect(routeTrailheadPins(routes)[0]?.numberLabel).toBe("1–6");
  });

  it("summarizes committed and in-progress boundaries using existing map values", () => {
    const coverage = [-122.19, 37.15, -122.13, 37.18] as [number, number, number, number];
    const boundary = [-122.18, 37.155, -122.14, 37.178] as [number, number, number, number];

    expect(mapStatusSummary(boundary, null, false, coverage, 2)).toEqual({
      boundary: "Area set",
      dimensions: "2.2 × 1.6 mi (3.5 sq mi)",
      coverage: "Inside coverage",
      accessPoints: "2 access points available",
    });
    expect(mapStatusSummary(boundary, null, true, coverage, 1)).toEqual({
      boundary: "Draw mode",
      accessPoints: "1 access point available",
    });
    expect(mapStatusSummary(boundary, [-122.20, 37.155, -122.14, 37.178], true, coverage, 0)).toMatchObject({
      boundary: "Drawing area",
      coverage: "Outside coverage",
      accessPoints: "0 access points available",
    });
  });

  it("renders compact accessible map controls, status, and a collapsed complete key", () => {
    const boundary = [-122.18, 37.155, -122.14, 37.178] as [number, number, number, number];
    const markup = renderToStaticMarkup(createElement(HikeMap, {
      mode: "drawn-area",
      drawBounds: boundary,
      drawEnabled: true,
      filterGeometry: { type: "Polygon", coordinates: [[[-122.18, 37.155], [-122.14, 37.155], [-122.14, 37.178], [-122.18, 37.178], [-122.18, 37.155]]] },
      packCoverageBbox: [-122.19, 37.15, -122.13, 37.18],
      packCoverage: { type: "Polygon", coordinates: [[[-122.19, 37.15], [-122.13, 37.15], [-122.13, 37.18], [-122.19, 37.18], [-122.19, 37.15]]] },
      suggestedBounds: boundary,
      display: { center: [-122.16, 37.165], zoom: 12 },
      trailNetwork: { type: "FeatureCollection", features: [] },
      accessPoints: [{
        id: "start",
        name: "Start",
        lon: -122.18,
        lat: 37.15,
        kind: "trailhead",
        accessState: "public",
        confidence: "high",
      }],
      routes: [route("first", -122.18)],
      onBoundsChange: () => undefined,
      onAccessPointSelect: () => undefined,
      onRouteSelect: () => undefined,
    }));

    expect(markup).toContain('aria-label="Hike search map"');
    expect(markup).toContain('role="toolbar" aria-label="Draw-area tools"');
    expect(markup).toContain('aria-label="Redraw trailhead filter"');
    expect(markup).toContain('aria-label="Use demo trailhead filter"');
    expect(markup).toContain('aria-label="Clear trailhead filter"');
    expect(markup).toContain('<output class="map-status" aria-label="Map status">');
    expect(markup).toContain('1 access point available');
    expect(markup).toContain('<details class="map-key map-key-collapsible">');
    expect(markup).not.toContain('<details open=""');
    expect(markup).toContain('<summary class="map-key-toggle">Map key</summary>');
    expect(markup).toContain('Installed coverage');
    expect(markup).toContain('Trailhead filter');
    expect(markup).toContain('Eligible access');
    expect(markup).toContain('Mapped trail');
    expect(markup).toContain('Suggested route');
    expect(markup).toContain('Route start');
    expect(markup).toContain('aria-label="OpenStreetMap attribution"');
  });
});
