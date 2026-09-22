import { describe, expect, it, vi } from "vitest";
import type { ElevationSampler } from "./adapters";
import {
  calculateEdgeMetrics,
  calculateEdgeMetricsBatch,
  densifyGeometry,
  distanceMeters,
  maximumSustainedGradePct,
  sampleElevations,
} from "./metrics";

describe("edge elevation metrics", () => {
  it("densifies geometry and calculates noise-filtered directional metrics", async () => {
    const geometry = [[-122.16, 37.16], [-122.158, 37.16]] as const;
    const sampler: ElevationSampler = {
      algorithmVersion: "test-v1",
      async sample(coordinates) {
        return coordinates.map((_, index) => 100 + index * 2);
      },
    };
    const dense = densifyGeometry(geometry);
    const metrics = await calculateEdgeMetrics(geometry, sampler);

    expect(dense.length).toBeGreaterThan(2);
    expect(metrics.lengthM).toBeCloseTo(distanceMeters(geometry[0], geometry[1]), 5);
    expect(metrics.gainM).toBe((dense.length - 1) * 2);
    expect(metrics.lossM).toBe(0);
    expect(metrics.maxElevationM).toBe(100 + (dense.length - 1) * 2);
    expect(metrics.maxSustainedGradePct).toBeGreaterThan(0);
  });

  it("marks every elevation metric unavailable when sampling has a gap", async () => {
    const sampler: ElevationSampler = {
      algorithmVersion: "test-v1",
      async sample(coordinates) {
        return coordinates.map((_, index) => index === 1 ? null : 100);
      },
    };
    const metrics = await calculateEdgeMetrics([[-122.16, 37.16], [-122.159, 37.16]], sampler);
    expect(metrics).toMatchObject({
      gainM: null,
      lossM: null,
      maxElevationM: null,
      maxSustainedGradePct: null,
    });
  });

  it("does not report a sustained grade for an edge shorter than 100 m", async () => {
    const sampler: ElevationSampler = {
      algorithmVersion: "test-v1",
      async sample(coordinates) {
        return coordinates.map((_, index) => 100 + index * 5);
      },
    };
    const metrics = await calculateEdgeMetrics([[-122.16, 37.16], [-122.1595, 37.16]], sampler);
    expect(metrics.lengthM).toBeGreaterThan(10);
    expect(metrics.lengthM).toBeLessThan(100);
    expect(metrics.maxElevationM).not.toBeNull();
    expect(metrics.maxSustainedGradePct).toBeNull();
  });

  it("uses exact rolling 100 m windows, including windows between profile samples", () => {
    expect(maximumSustainedGradePct([
      { distanceMeters: 0, elevationMeters: 0 },
      { distanceMeters: 40, elevationMeters: 0 },
      { distanceMeters: 80, elevationMeters: 12 },
      { distanceMeters: 140, elevationMeters: 12 },
    ])).toBeCloseTo(12, 8);
  });

  it("batches multiple edge geometries into bounded sampler calls", async () => {
    const sample = vi.fn(async (coordinates: ReadonlyArray<readonly [number, number]>) =>
      coordinates.map((_, index) => 100 + index));
    const geometries = [
      [[-122.16, 37.16], [-122.1598, 37.16]],
      [[-122.1598, 37.16], [-122.1596, 37.16]],
      [[-122.1596, 37.16], [-122.1594, 37.16]],
    ] as const;
    const metrics = await calculateEdgeMetricsBatch(geometries, { algorithmVersion: "test", sample }, 4);
    expect(metrics).toHaveLength(3);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(metrics.every(({ lengthM }) => lengthM > 0)).toBe(true);
  });

  it.each([1, 3, 17, 20_000])("preserves sample order, missing data and exact metrics with a %i-coordinate budget", async (budget) => {
    const geometries = [
      [[-122.16, 37.16], [-122.1599, 37.16]],
      [[-122.1599, 37.16], [-122.15, 37.161], [-122.14, 37.16]],
      [[-122.14, 37.16], [-122.1398, 37.16]],
    ] as const;
    const elevation = ([lon, lat]: readonly [number, number]) => lon > -122.141 ? null : 100 + Math.sin(lon * 10_000) * 20 + lat;
    const sample = vi.fn(async (coordinates: ReadonlyArray<readonly [number, number]>) => coordinates.map(elevation));
    const sampler = { algorithmVersion: "test", sample };
    const expected = await Promise.all(geometries.map((geometry) => calculateEdgeMetrics(geometry, {
      algorithmVersion: "test", sample: async (coordinates) => coordinates.map(elevation),
    })));
    expect(await calculateEdgeMetricsBatch(geometries, sampler, budget)).toEqual(expected);
    expect(sample.mock.calls.every(([coordinates]) => coordinates.length <= budget)).toBe(true);
    expect(sample.mock.calls.flatMap(([coordinates]) => coordinates)).toEqual(geometries.flatMap(densifyGeometry));
    expect(expected[0]!.elevationProfile).not.toBeNull();
    expect(expected[1]!.elevationProfile).toBeNull();
    expect(expected[2]!.elevationProfile).toBeNull();
  });

  it.each([-1, 1])("rejects %i extra or missing values in an expanded-edge sampling chunk", async (difference) => {
    const sample = vi.fn(async (coordinates: ReadonlyArray<readonly [number, number]>) => Array<number>(coordinates.length + difference).fill(100));
    await expect(calculateEdgeMetricsBatch([[[0, 0], [0.001, 0]]], { algorithmVersion: "test", sample }, 2))
      .rejects.toThrow(`Elevation sampler returned ${2 + difference} values for 2 coordinates`);
  });

  it("does not call the sampler for empty input and rejects invalid budgets", async () => {
    const sample = vi.fn(async () => []);
    const sampler = { algorithmVersion: "test", sample };
    expect(await calculateEdgeMetricsBatch([], sampler)).toEqual([]);
    expect(await sampleElevations([], sampler)).toEqual([]);
    expect(sample).not.toHaveBeenCalled();
    for (const budget of [0, -1, 0.5, Infinity, NaN]) {
      await expect(calculateEdgeMetricsBatch([], sampler, budget)).rejects.toThrow("positive integer");
      await expect(sampleElevations([], sampler, budget)).rejects.toThrow("positive integer");
    }
  });

});
