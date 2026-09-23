// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts/routes";
import { routeGpx, routeGpxFilename } from "./route-gpx";

const namespace = "http://www.topografix.com/GPX/1/1";
const route: Pick<GeneratedClosedRouteV3, "geometry" | "startAccessPoint" | "warnings" | "source"> = {
  geometry: {
    type: "LineString",
    coordinates: [
      [-122.12, 37.23], [-122.13, 37.24], [-122.14, 37.25],
      [-122.15, 37.24], [-122.13, 37.24], [-122.12, 37.23],
    ],
  },
  startAccessPoint: {
    id: "start", name: 'Crête & <Creek> "Entrance"', lon: -122.121, lat: 37.231,
    accessState: "unknown", confidence: "medium",
  },
  source: { freshness: "2026-09-01T00:00:00.000Z", confidence: "medium", sourceIds: ["osm&agency", "3dep"] },
  warnings: ['Unknown <access> & seasonal restrictions', 'Use "caution"'],
};

function parse(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  expect(document.querySelector("parsererror")).toBeNull();
  return document;
}

function elements(document: Document, tag: string): Element[] {
  return Array.from(document.getElementsByTagNameNS(namespace, tag));
}

describe("routeGpx", () => {
  it("exports the full ordered path in one GPX 1.1 track, preserving retraces and closure", () => {
    // Older saved results have no trailSegments; full route geometry is sufficient.
    const xml = routeGpx(route, "Route 1");
    const document = parse(xml);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(document.documentElement.namespaceURI).toBe(namespace);
    expect(document.documentElement.getAttribute("version")).toBe("1.1");
    expect(elements(document, "trk")).toHaveLength(1);
    expect(elements(document, "trkseg")).toHaveLength(1);
    expect(elements(document, "rte")).toHaveLength(0);
    const points = elements(document, "trkpt").map((point) => [
      Number(point.getAttribute("lon")), Number(point.getAttribute("lat")),
    ]);
    expect(points).toEqual(route.geometry.coordinates);
    expect(elements(document, "ele")).toHaveLength(0);
    expect(elements(document, "time")).toHaveLength(0);
    const start = elements(document, "wpt")[0];
    expect(start.getAttribute("lon")).toBe("-122.12");
    expect(start.getAttribute("lat")).toBe("37.23");
    expect(start.textContent?.trim()).toBe(route.startAccessPoint.name);
  });

  it("round-trips Unicode and XML punctuation while retaining provenance and warnings", () => {
    const name = 'Crête & <Loop> "West" — hiker\'s 🥾';
    const document = parse(routeGpx(route, name));
    expect(elements(document, "name").map((element) => element.textContent)).toEqual([
      route.startAccessPoint.name, name,
    ]);
    const description = elements(document, "desc")[0].textContent;
    expect(description).toContain("Sources: osm&agency, 3dep");
    expect(description).toContain(`Source freshness: ${route.source.freshness}`);
    expect(description).toContain("Source confidence: medium");
    for (const warning of route.warnings) expect(description).toContain(`Warning: ${warning}`);
  });

  it("replaces invalid XML characters without destroying valid whitespace or supplementary Unicode", () => {
    const name = `A${String.fromCharCode(0, 1, 0xd800, 0xffff)}\t\nB 🥾`;
    const document = parse(routeGpx(route, name));
    expect(elements(document, "name")[1].textContent).toBe("A����\t\nB 🥾");
  });

  it("does not treat profile samples or segment geometry as track point elevations or replacements", () => {
    const withExtraFields = {
      ...route,
      elevationSamples: [{ distanceMeters: 0, elevationMeters: 120 }],
      trailSegments: [{ geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }],
    };
    const document = parse(routeGpx(withExtraFields, "Saved route"));
    expect(elements(document, "trkpt")).toHaveLength(route.geometry.coordinates.length);
    expect(elements(document, "ele")).toHaveLength(0);
  });
});

describe("routeGpxFilename", () => {
  it("produces recognizable, bounded, portable GPX filenames", () => {
    expect(routeGpxFilename("Crête / Creek: Route 1")).toBe("alpine-loop-crete-creek-route-1.gpx");
    for (const name of ["", ".. / \\", "🥾", "CON", "NUL", "x".repeat(1000)]) {
      const filename = routeGpxFilename(name);
      expect(filename).toMatch(/^alpine-loop-[a-z0-9-]+\.gpx$/);
      expect(filename.length).toBeLessThanOrEqual(116);
    }
    expect(routeGpxFilename("")).toBe("alpine-loop-route.gpx");
  });
});
