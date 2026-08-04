import { describe, expect, it } from "vitest";
import type { ElevationSampler } from "./adapters";
import { calculateEdgeMetrics, densifyGeometry, distanceMeters } from "./metrics";

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
});
