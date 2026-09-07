import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard, copyTextWithDocument } from "../clipboard";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts";
import {
  HikeMap,
  ROUTE_PIN_CLUSTER_RADIUS_PX,
  accessPointClusterHoverFilter,
  accessPointFeatureDetails,
  accessPointFeatures,
  clusterRouteTrailheadPins,
  accessPointHoverFilter,
  contextMenuPosition,
  formatCoordinates,
  mapDataSchema,
  coverageFeatures,
  regionBoundaryVisibility,
  REGION_BOUNDARY_PAINT,
  routeFeaturePartitions,
  routeFeatures,
  resultAccessPointIds,
  routeSegmentFeatures,
  routeTrailheadPins,
  trailNetworkFeatureDetails,
  trailNetworkLineColor,
  trailNetworkLineWidth,
  mapRequestUrl,
} from "./HikeMap";

function route(id: string, longitude: number): GeneratedClosedRouteV3 {
  return {
    id,
    geometry: { type: "LineString", coordinates: [[longitude, 37.15], [longitude + 0.01, 37.16], [longitude, 37.15]] },
    startAccessPoint: { id: "start", name: "Start", lon: longitude, lat: 37.15, accessState: "public", confidence: "high" },
    distanceMeters: 1000,
    elevationGainMeters: 100,
    elevationLossMeters: 100,
    minimumElevationMeters: 200,
    maximumElevationMeters: 300,
    steepestSustainedGradePct: 5,
    topology: {
      kind: "simple-loop",
      cycleCount: 1,
      cycleBlockCount: 1,
      repeatedTrailDistanceMeters: 0,
      repeatedTrailFraction: 0,
      sharedStemDistanceMeters: 0,
      connectorCount: 0,
    },
    trailNames: ["Fixture Trail"],
    trailSegments: [{
      id: `${id}:segment:1`,
      geometry: { type: "LineString", coordinates: [[longitude, 37.15], [longitude + 0.01, 37.16]] },
      name: "Fixture Trail",
      distanceMeters: 500,
      startDistanceMeters: 0,
      endDistanceMeters: 500,
      accessState: "public",
      condition: { highway: "path", surface: "dirt" },
      sourceFeatureId: "way/1",
      sourceIds: ["fixture"],
    }],
    warnings: [],
    source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["fixture"] },
  };
}

describe("generated route map features", () => {
  it("keeps access-point names and types available for restrained map hover UI", () => {
    const [feature] = accessPointFeatures([{
      id: "coe-hq",
      name: "  Henry Coe Headquarters  ",
      lon: -121.55,
      lat: 37.19,
      kind: "parking",
      accessState: "public",
      confidence: "high",
    }]).features;

    expect(feature?.properties).toMatchObject({ id: "coe-hq", name: "  Henry Coe Headquarters  ", kind: "parking" });
    expect(accessPointFeatureDetails(feature?.properties)).toEqual({
      id: "coe-hq",
      kindLabel: "Parking",
      name: "Henry Coe Headquarters",
      copyName: "Henry Coe Headquarters",
    });
    expect(accessPointFeatureDetails({ id: "unnamed", kind: "trailhead", name: " " })).toEqual({
      id: "unnamed",
      kindLabel: "Trailhead",
      name: "Unnamed access point",
      copyName: undefined,
    });
    expect(accessPointHoverFilter("coe-hq")).toEqual(["==", ["get", "id"], "coe-hq"]);
    expect(accessPointHoverFilter()).toEqual(["==", ["get", "id"], "__none__"]);
    expect(accessPointClusterHoverFilter(42)).toEqual(["==", ["get", "cluster_id"], 42]);
    expect(accessPointClusterHoverFilter()).toEqual(["==", ["get", "cluster_id"], -1]);
  });

  it("loads mapped trails only at detailed zoom and keeps hover names useful", () => {
    const bounds = [-122.18, 37.155, -122.14, 37.178] as [number, number, number, number];

    expect(mapRequestUrl(bounds, 12)).toBe("/api/map?bbox=-122.18%2C37.155%2C-122.14%2C37.178&trails=1");
    expect(mapRequestUrl(bounds, 11)).toBe("/api/map?bbox=-122.18%2C37.155%2C-122.14%2C37.178&trails=0");
    expect(trailNetworkFeatureDetails({ name: "  Skyline Trail  ", distanceMeters: 965.6064 })).toEqual({
      name: "Skyline Trail",
      copyName: "Skyline Trail",
      distance: "0.6 mi",
    });
    expect(trailNetworkFeatureDetails({ name: null, distanceMeters: 30 })).toEqual({
      name: "Unnamed trail",
      copyName: undefined,
      distance: "98 ft",
    });
    expect(trailNetworkLineColor()).toBe("#3f5f52");
    expect(trailNetworkLineColor("trail-group:edge-12")).toEqual([
      "case",
      ["==", ["get", "trailGroupId"], "trail-group:edge-12"],
      "#244c3d",
      "#3f5f52",
    ]);
    expect(trailNetworkLineWidth()).toBe(2.4);
    expect(trailNetworkLineWidth("trail-group:edge-12")).toEqual([
      "case",
      ["==", ["get", "trailGroupId"], "trail-group:edge-12"],
      2.7,
      2.4,
    ]);
  });

  it("accepts server-owned map identities and rejects malformed geometry", () => {
    const payload = { accessPoints: [], trailNetwork: { type: "FeatureCollection", features: [{
      type: "Feature", properties: { trailGroupId: "region:trail-1" }, geometry: { type: "LineString", coordinates: [[-122, 37], [-121.9, 37.1]] },
    }] } };
    expect(mapDataSchema.parse(payload).trailNetwork.features[0]?.properties.trailGroupId).toBe("region:trail-1");
    expect(mapDataSchema.safeParse({ ...payload, trailNetwork: { ...payload.trailNetwork, features: [{ ...payload.trailNetwork.features[0], geometry: { type: "LineString", coordinates: [] } }] } }).success).toBe(false);
  });

  it("copies the displayed mapped-trail name and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fallbackCopy = vi.fn().mockReturnValue(true);

    await expect(copyTextToClipboard("Bloom Grade", { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("Bloom Grade");
    await expect(copyTextToClipboard("Bloom Grade", { writeText }, fallbackCopy)).resolves.toBe(true);
    expect(fallbackCopy).toHaveBeenCalledWith("Bloom Grade");
    expect(writeText).toHaveBeenCalledTimes(2);
    await expect(copyTextToClipboard("Bloom Grade", { writeText: vi.fn().mockRejectedValue(new Error("denied")) })).resolves.toBe(false);
    await expect(copyTextToClipboard("Bloom Grade", undefined)).resolves.toBe(false);
    await expect(copyTextToClipboard(undefined, { writeText })).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("labels a right-clicked location the way another map expects it pasted", () => {
    expect(formatCoordinates(-122.1637283, 37.1552891)).toBe("37.15529, -122.16373");
    // Panning east past the antimeridian keeps counting the longitude up.
    expect(formatCoordinates(190.5, -33.25)).toBe("-33.25000, -169.50000");
  });

  it("keeps the right-click menu inside the map when the click lands near an edge", () => {
    const container = { width: 400, height: 300 };

    expect(contextMenuPosition({ x: 120, y: 90 }, container)).toEqual({ left: 120, top: 90 });
    expect(contextMenuPosition({ x: 395, y: 298 }, container)).toEqual({ left: 200, top: 266 });
    expect(contextMenuPosition({ x: 10, y: 10 }, { width: 100, height: 20 })).toEqual({ left: 0, top: 0 });
  });

  it("copies synchronously while the map click still has browser activation", () => {
    const textarea = {
      value: "",
      setAttribute: vi.fn(),
      style: {},
      select: vi.fn(),
      remove: vi.fn(),
    };
    const copyDocument = {
      activeElement: null,
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(true),
    } as unknown as Document;

    expect(copyTextWithDocument("Bloom Grade", copyDocument)).toBe(true);
    expect(textarea.value).toBe("Bloom Grade");
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(copyDocument.execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  it("renders every selected pack coverage and maps the setting to layer visibility", () => {
    const coverages = [
      { type: "Polygon" as const, coordinates: [[[-122.2, 37.1], [-122.1, 37.1], [-122.1, 37.2], [-122.2, 37.2], [-122.2, 37.1]]] },
      { type: "MultiPolygon" as const, coordinates: [[[[-121.9, 37.3], [-121.8, 37.3], [-121.8, 37.4], [-121.9, 37.4], [-121.9, 37.3]]]] },
    ];

    expect(coverageFeatures(coverages).features.map((feature) => feature.geometry)).toEqual(coverages);
    expect(regionBoundaryVisibility(false)).toBe("none");
    expect(regionBoundaryVisibility(true)).toBe("visible");
    expect(REGION_BOUNDARY_PAINT).toEqual({
      "line-color": "#111111",
      "line-width": 0.8,
      "line-opacity": 0.58,
    });
    expect(REGION_BOUNDARY_PAINT).not.toHaveProperty("line-dasharray");
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

  it("exposes only the selected route segments and isolates the focused segment", () => {
    const routes = [route("first", -122.18), route("second", -122.16)];
    const all = routeSegmentFeatures(routes, "second");
    const focused = routeSegmentFeatures(routes, "second", "second:segment:1");

    expect(all.features.map(({ properties }) => properties?.id)).toEqual(["second:segment:1"]);
    expect(all.features[0]?.properties).toMatchObject({ routeId: "second", segmentNumber: 1, name: "Fixture Trail" });
    expect(focused.features[0]?.geometry).toEqual(routes[1]?.trailSegments?.[0]?.geometry);
    expect(routeSegmentFeatures(routes, "second", "missing").features).toEqual([]);
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

  it("omits generic access-point dots while a result marker represents that trailhead", () => {
    const accessPoints = [
      { id: "start", name: "Result start", lon: -122.18, lat: 37.15, kind: "trailhead" as const, accessState: "public" as const, confidence: "high" as const },
      { id: "other", name: "Other start", lon: -122.16, lat: 37.15, kind: "trailhead" as const, accessState: "public" as const, confidence: "high" as const },
    ];

    expect(accessPointFeatures(accessPoints, resultAccessPointIds([route("first", -122.18)]))
      .features.map(({ properties }) => properties?.id)).toEqual(["other"]);
    expect(accessPointFeatures(accessPoints).features).toHaveLength(2);
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

  it("groups nearby result starts at low zoom and separates them as the map zooms in", () => {
    const pins = routeTrailheadPins([
      route("first", -122.18),
      route("second", -122.179),
    ], "second");
    const projectAtScale = (scale: number) => (coordinates: [number, number]) => ({
      x: coordinates[0] * scale,
      y: coordinates[1] * scale,
    });
    const lowZoom = clusterRouteTrailheadPins(
      pins,
      "second",
      projectAtScale(21_000),
    );
    const highZoom = clusterRouteTrailheadPins(
      pins,
      "second",
      projectAtScale(23_000),
      ROUTE_PIN_CLUSTER_RADIUS_PX,
    );

    expect(lowZoom).toHaveLength(1);
    expect(lowZoom[0]).toMatchObject({
      coordinates: [-122.179, 37.15],
      routeIds: ["first", "second"],
      routeNumbers: [1, 2],
      numberLabel: "1·2",
      selected: true,
      nextRouteId: "first",
    });
    expect(highZoom.map(({ numberLabel }) => numberLabel)).toEqual(["1", "2"]);
  });

  it("renders compact accessible map controls and a collapsed complete key", () => {
    const boundary = [-122.18, 37.155, -122.14, 37.178] as [number, number, number, number];
    const markup = renderToStaticMarkup(createElement(HikeMap, {
      drawBounds: boundary,
      filterGeometry: { type: "Polygon", coordinates: [[[-122.18, 37.155], [-122.14, 37.155], [-122.14, 37.178], [-122.18, 37.178], [-122.18, 37.155]]] },
      coverages: [{ type: "Polygon", coordinates: [[[-122.19, 37.15], [-122.13, 37.15], [-122.13, 37.18], [-122.19, 37.18], [-122.19, 37.15]]] }],
      showRegionBoundaries: false,
      display: { center: [-122.16, 37.165], zoom: 12 },
      includeUncertainAccess: true,
      routes: [route("first", -122.18)],
      onBoundsChange: () => undefined,
      onRouteSelect: () => undefined,
    }));

    expect(markup).toContain('aria-label="Hike search map"');
    expect(markup).toContain('<div class="map-canvas"></div>');
    expect(markup).not.toContain('class="map-canvas" aria-hidden="true"');
    expect(markup).toContain('role="toolbar" aria-label="Draw-area tools"');
    expect(markup).toContain('aria-label="Redraw trailhead filter"');
    expect(markup).not.toContain("Demo");
    expect(markup).toContain('aria-label="Clear trailhead filter"');
    expect(markup).not.toContain('map-status');
    expect(markup).not.toContain('Highlighted areas filter trailheads');
    expect(markup).not.toContain('<p class="map-hint"');
    expect(markup).toContain('<details class="map-key map-key-collapsible">');
    expect(markup).not.toContain('<details open=""');
    expect(markup).toContain('<summary class="map-key-toggle">Map key</summary>');
    expect(markup).not.toContain('Installed coverage');
    expect(markup).toContain('Trailhead filter');
    expect(markup).toContain('Trailhead');
    expect(markup).toContain('Mapped trail');
    expect(markup).toContain('Suggested route');
    expect(markup).toContain('Route start');
    expect(markup).toContain('aria-label="OpenStreetMap attribution"');
  });
});
