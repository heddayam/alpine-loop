import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HikeRoute, Position } from "../../src/model.js";
import {
  ElevationProfile,
  elevationGrade,
  elevationPosition,
  elevationSamples,
} from "../../src/client/ElevationProfile.js";

// One degree along the equator: pi * 6,371,008.8 / 180 meters.
const DEGREE = 111195.0802335329;
const point = (longitude: number, elevation?: number): Position =>
  elevation === undefined ? [longitude, 0] : [longitude, 0, elevation];

const route = (geometry: Position[]): HikeRoute => ({
  id: "test",
  startId: "start",
  startName: "Start",
  startKind: "trailhead",
  startPosition: geometry[0]!,
  trailNames: [],
  distance: 1,
  gain: 1,
  roadDistance: 0,
  repetition: 0,
  kind: "loop",
  uncertain: false,
  geometry,
});

describe("distance-indexed saved elevation geometry", () => {
  it("measures horizontal distance without letting elevation or reported metrics stretch the profile", () => {
    const geometry: Position[] = [point(0, 0), point(1, 100000), point(2, 0)];
    const samples = elevationSamples(geometry);
    expect(samples.map((sample) => sample.distance)).toEqual([
      0,
      DEGREE,
      DEGREE * 2,
    ]);
    const markup = renderToStaticMarkup(
      createElement(ElevationProfile, {
        route: route(geometry),
        onHover: () => {},
      }),
    );
    expect(markup).toContain("138.2 mi");
    expect(markup).toContain("Distance (mi)");
    expect(markup).toContain("Elevation (ft)");
  });

  it("interpolates coordinates and elevation at the hovered distance and clamps to exact endpoints", () => {
    const samples = elevationSamples([
      point(0, 100),
      point(1, 300),
      point(2, 200),
    ]);
    expect(elevationPosition(samples, DEGREE / 4)).toEqual([0.25, 0, 150]);
    expect(elevationPosition(samples, DEGREE * 1.5)).toEqual([1.5, 0, 250]);
    expect(elevationPosition(samples, -100)).toEqual([0, 0, 100]);
    expect(elevationPosition(samples, DEGREE * 3)).toEqual([2, 0, 200]);
  });

  it("keeps repeated lollipop passages separate and reverses the elevation walk", () => {
    const geometry = [
      point(0, 100),
      point(1, 200),
      point(2, 400),
      point(1, 200),
      point(0, 100),
    ];
    const samples = elevationSamples(geometry);
    expect(samples.at(-1)!.distance).toBeCloseTo(DEGREE * 4, 6);
    expect(elevationPosition(samples, DEGREE * 3.5)).toEqual([0.5, 0, 150]);
    const walk = [point(0, 100), point(1, 200), point(2, 400)];
    const forward = elevationSamples(walk);
    const backward = elevationSamples([...walk].reverse());
    const distance = DEGREE * 0.4;
    expect(
      elevationPosition(backward, backward.at(-1)!.distance - distance),
    ).toEqual(elevationPosition(forward, distance));
  });

  it("handles coincident samples and zero-length routes without dividing by zero", () => {
    const samples = elevationSamples([
      point(0, 10),
      point(0, 20),
      point(1, 100),
      point(1, 110),
    ]);
    expect(samples.map((sample) => sample.distance)).toEqual([
      0,
      0,
      DEGREE,
      DEGREE,
    ]);
    expect(elevationPosition(samples, 0)).toEqual([0, 0, 10]);
    expect(elevationPosition(samples, DEGREE / 2)).toEqual([0.5, 0, 60]);
    expect(elevationPosition(samples, DEGREE)).toEqual([1, 0, 110]);
    expect(
      elevationPosition(elevationSamples([point(0, 10), point(0, 20)]), 10),
    ).toEqual([0, 0, 20]);
    expect(elevationPosition([], 0)).toBeNull();
  });

  it("preserves missing elevation gaps rather than estimating unavailable heights", () => {
    const geometry = [point(0, 100), point(1), point(2, 300)];
    const samples = elevationSamples(geometry);
    expect(elevationPosition(samples, DEGREE / 2)).toEqual([0.5, 0]);
    expect(elevationPosition(samples, DEGREE)).toEqual([1, 0]);
    expect(elevationPosition(samples, DEGREE * 1.5)).toEqual([1.5, 0]);
    const markup = renderToStaticMarkup(
      createElement(ElevationProfile, {
        route: route(geometry),
        onHover: () => {},
      }),
    );
    expect(markup).toMatch(/class="profile-line" d="M[^"]+M[^"]+"/);
    expect(markup).not.toContain("NaN");
    const noElevations = renderToStaticMarkup(
      createElement(ElevationProfile, {
        route: route([point(0), point(1, NaN)]),
        onHover: () => {},
      }),
    );
    expect(noElevations).toContain("No elevation data");
    expect(noElevations).not.toContain("profile-line");
  });

  it("interpolates a short segment across the antimeridian rather than traversing the world", () => {
    const samples = elevationSamples([point(179, 100), point(-179, 200)]);
    expect(samples.at(-1)!.distance).toBeCloseTo(DEGREE * 2, 6);
    expect(elevationPosition(samples, samples.at(-1)!.distance / 2)).toEqual([
      -180, 0, 150,
    ]);
  });

  it("reports signed rise over horizontal run, including short routes and one-sided endpoints", () => {
    for (const length of [40, 200]) {
      const geometry = [
        point(0, 100),
        point(length / DEGREE, 100 + length / 10),
      ];
      const samples = elevationSamples(geometry);
      const reversed = elevationSamples([...geometry].reverse());
      for (const distance of [0, length / 2, length]) {
        expect(elevationGrade(samples, distance)).toBeCloseTo(10, 8);
        expect(elevationGrade(reversed, length - distance)).toBeCloseTo(-10, 8);
      }
    }
    expect(
      elevationGrade(elevationSamples([point(0, 10), point(1, 10)]), 100),
    ).toBe(0);
    expect(
      elevationGrade(elevationSamples([point(0, 10), point(0, 20)]), 0),
    ).toBeNull();
    expect(elevationGrade([], 0)).toBeNull();
  });

  it("averages a local stretch and refuses to bridge missing elevation inside it", () => {
    const geometry = [
      point(0, 100),
      point(50 / DEGREE, 105),
      point(100 / DEGREE, 125),
      point(150 / DEGREE, 115),
      point(200 / DEGREE, 120),
    ];
    expect(elevationGrade(elevationSamples(geometry), 100)).toBeCloseTo(10, 8);
    geometry[2] = point(100 / DEGREE);
    const samples = elevationSamples(geometry);
    expect(elevationGrade(samples, 100)).toBeNull();
    expect(elevationGrade(samples, 75)).toBeNull();
    expect(elevationGrade(samples, 0)).toBeCloseTo(10, 8);
  });
});
