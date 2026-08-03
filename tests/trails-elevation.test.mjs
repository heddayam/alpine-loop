import assert from "node:assert/strict";
import test from "node:test";
import {
  createElevationManifestMetadata,
  elevationSampleLocations,
  loadCachedElevationGrid,
  sampleElevationProfile,
} from "../scripts/trails/elevation/profile.mjs";
import {
  applyElevationMetrics,
  calculateElevationMetrics,
} from "../scripts/trails/elevation/metrics.mjs";

const fixtureUrl = new URL("./fixtures/trails/elevation/three-dep-grid.json", import.meta.url);

function profile(elevations, spacingMeters = 10) {
  return elevations.map((elevationMeters, index) => ({
    distanceMeters: index * spacingMeters,
    elevationMeters,
  }));
}

function reversedProfile(samples) {
  const totalDistance = samples.at(-1).distanceMeters;
  return [...samples].reverse().map((sample) => ({
    distanceMeters: totalDistance - sample.distanceMeters,
    elevationMeters: sample.elevationMeters,
  }));
}

test("samples a cached 3DEP grid at no more than the documented spacing", async () => {
  const source = await loadCachedElevationGrid(fixtureUrl);
  const geometry = {
    type: "LineString",
    coordinates: [[-119.721, 37.805], [-119.7206, 37.805]],
  };
  const result = await sampleElevationProfile(geometry, source);

  assert.equal(result.coverage, "complete");
  assert.equal(result.missingSampleCount, 0);
  assert.equal(result.samples[0].elevationMeters, 1000);
  assert.ok(Math.abs(result.samples.at(-1).elevationMeters - 1040) < 1e-6);
  for (let index = 1; index < result.samples.length; index += 1) {
    assert.ok(
      result.samples[index].distanceMeters - result.samples[index - 1].distanceMeters <= 10,
    );
  }

  const forward = elevationSampleLocations(geometry);
  const reverse = elevationSampleLocations({
    ...geometry,
    coordinates: [...geometry.coordinates].reverse(),
  });
  assert.equal(forward.length, reverse.length);
  assert.deepEqual(
    forward.map(({ longitude, latitude }) => [longitude, latitude]),
    reverse.map(({ longitude, latitude }) => [longitude, latitude]).reverse(),
  );
});

test("reversing a segment swaps ascent and descent within metric precision", () => {
  const forwardProfile = profile([100, 103, 102, 110, 108]);
  const forward = calculateElevationMetrics(forwardProfile);
  const reverse = calculateElevationMetrics(reversedProfile(forwardProfile));

  assert.equal(forward.ascentForwardMeters, reverse.descentForwardMeters);
  assert.equal(forward.descentForwardMeters, reverse.ascentForwardMeters);
  assert.equal(forward.minElevationMeters, reverse.minElevationMeters);
  assert.equal(forward.maxElevationMeters, reverse.maxElevationMeters);
  assert.equal(forward.maxGradePct, reverse.maxGradePct);
});

test("flat synthetic DEM noise does not accumulate artificial gain or loss", () => {
  const metrics = calculateElevationMetrics(profile([100, 100.4, 99.7, 100.2, 100]));
  assert.equal(metrics.ascentForwardMeters, 0);
  assert.equal(metrics.descentForwardMeters, 0);
  assert.equal(metrics.maxGradePct, 0);
  assert.equal(metrics.minElevationMeters, 99.7);
  assert.equal(metrics.maxElevationMeters, 100.4);
});

test("missing cached raster coverage omits metrics instead of reporting zero", async () => {
  const source = await loadCachedElevationGrid(fixtureUrl);
  const sampled = await sampleElevationProfile({
    type: "LineString",
    coordinates: [[-119.721, 37.805], [-119.72, 37.805]],
  }, source);
  assert.equal(sampled.coverage, "missing");
  assert.ok(sampled.missingSampleCount > 0);
  assert.deepEqual(calculateElevationMetrics(sampled), {});

  const enriched = applyElevationMetrics({
    id: "segment-outside-coverage",
    ascentForwardMeters: 999,
    descentForwardMeters: 999,
    minElevationMeters: 0,
    maxElevationMeters: 999,
    maxGradePct: 99,
  }, sampled);
  for (const field of [
    "ascentForwardMeters",
    "descentForwardMeters",
    "minElevationMeters",
    "maxElevationMeters",
    "maxGradePct",
  ]) {
    assert.equal(enriched[field], undefined);
  }
});

test("exports source version and processing settings for the regional manifest", async () => {
  const source = await loadCachedElevationGrid(fixtureUrl);
  assert.deepEqual(createElevationManifestMetadata(source), {
    source: {
      provider: "USGS",
      product: "3DEP 1/3 arc-second DEM",
      version: "fixture-2026-08-03",
      verticalDatum: "NAVD88",
      sourceUrl: "https://www.usgs.gov/3d-elevation-program",
    },
    sampling: {
      method: "equal-distance-geodesic",
      maximumSpacingMeters: 10,
      interpolation: "bilinear",
    },
    smoothing: {
      method: "centered-moving-mean-with-vertical-noise-floor",
      windowMeters: 30,
      noiseThresholdMeters: 1,
    },
    missingCoverage: "omit-segment-elevation-metrics",
  });
});

test("sampling never falls back to the USGS point API", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access is forbidden in elevation tests");
  };
  try {
    const sampled = await sampleElevationProfile({
      type: "LineString",
      coordinates: [[-119.721, 37.805], [-119.7209, 37.805]],
    }, () => 1234);
    assert.equal(sampled.coverage, "complete");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
