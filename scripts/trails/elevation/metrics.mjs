import {
  DEFAULT_NOISE_THRESHOLD_METERS,
  DEFAULT_SMOOTHING_WINDOW_METERS,
} from "./profile.mjs";

export const ELEVATION_METRIC_FIELDS = Object.freeze([
  "ascentForwardMeters",
  "descentForwardMeters",
  "minElevationMeters",
  "maxElevationMeters",
  "maxGradePct",
]);

function option(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return result;
}

function profileSamples(profile) {
  const samples = Array.isArray(profile) ? profile : profile?.samples;
  if (!Array.isArray(samples) || samples.length < 2) return null;
  let previousDistance = -Infinity;

  for (const [index, sample] of samples.entries()) {
    if (!sample || !Number.isFinite(sample.distanceMeters)) {
      throw new TypeError(`profile sample ${index} must have a finite distanceMeters`);
    }
    if (sample.distanceMeters <= previousDistance) {
      throw new TypeError("profile sample distances must be strictly increasing");
    }
    previousDistance = sample.distanceMeters;
    if (!Number.isFinite(sample.elevationMeters)) return null;
  }
  return samples;
}

function centeredMovingMean(samples, windowMeters) {
  if (windowMeters === 0) return samples.map(({ elevationMeters }) => elevationMeters);
  const radius = windowMeters / 2;
  return samples.map((sample, index) => {
    // Preserve sampled endpoints so a steady climb keeps its full net change.
    if (index === 0 || index === samples.length - 1) return sample.elevationMeters;
    let total = 0;
    let count = 0;
    for (const candidate of samples) {
      if (Math.abs(candidate.distanceMeters - sample.distanceMeters) <= radius + 1e-9) {
        total += candidate.elevationMeters;
        count += 1;
      }
    }
    return total / count;
  });
}

function trendAnchors(samples, elevations, noiseThresholdMeters) {
  const range = Math.max(...elevations) - Math.min(...elevations);
  if (range <= noiseThresholdMeters) {
    return [
      { distanceMeters: samples[0].distanceMeters, elevationMeters: elevations[0] },
      { distanceMeters: samples.at(-1).distanceMeters, elevationMeters: elevations[0] },
    ];
  }

  const retained = new Set([0, samples.length - 1]);
  const ranges = [[0, samples.length - 1]];

  while (ranges.length > 0) {
    const [first, last] = ranges.pop();
    const distanceSpan = samples[last].distanceMeters - samples[first].distanceMeters;
    let greatestResidual = noiseThresholdMeters;
    let greatestIndices = [];

    for (let index = first + 1; index < last; index += 1) {
      const fraction = distanceSpan === 0
        ? 0
        : (samples[index].distanceMeters - samples[first].distanceMeters) / distanceSpan;
      const expectedElevation = elevations[first] +
        (elevations[last] - elevations[first]) * fraction;
      const residual = Math.abs(elevations[index] - expectedElevation);
      if (residual > greatestResidual + 1e-9) {
        greatestResidual = residual;
        greatestIndices = [index];
      } else if (greatestIndices.length > 0 && Math.abs(residual - greatestResidual) <= 1e-9) {
        // Retaining exact ties makes the simplification invariant to reversal.
        greatestIndices.push(index);
      }
    }

    if (greatestIndices.length === 0) continue;
    for (const index of greatestIndices) retained.add(index);
    const boundaries = [first, ...greatestIndices, last];
    for (let index = 1; index < boundaries.length; index += 1) {
      if (boundaries[index] - boundaries[index - 1] > 1) {
        ranges.push([boundaries[index - 1], boundaries[index]]);
      }
    }
  }

  return [...retained].sort((left, right) => left - right).map((index) => ({
    distanceMeters: samples[index].distanceMeters,
    elevationMeters: elevations[index],
  }));
}

/**
 * Smooth a complete profile using a centered distance window, then discard
 * vertical departures no larger than the configured DEM noise floor. The
 * operations are symmetric so reversing the samples produces the same trend
 * in reverse.
 */
export function smoothElevationProfile(profile, options = {}) {
  const samples = profileSamples(profile);
  if (!samples) return [];
  const smoothingWindowMeters = option(
    options.smoothingWindowMeters,
    DEFAULT_SMOOTHING_WINDOW_METERS,
    "smoothingWindowMeters",
  );
  const noiseThresholdMeters = option(
    options.noiseThresholdMeters,
    DEFAULT_NOISE_THRESHOLD_METERS,
    "noiseThresholdMeters",
  );
  const elevations = centeredMovingMean(samples, smoothingWindowMeters);
  return trendAnchors(samples, elevations, noiseThresholdMeters);
}

function rounded(value, digits = 1) {
  const result = Number(value.toFixed(digits));
  return Object.is(result, -0) ? 0 : result;
}

/** Missing coverage returns an empty object; zero is reserved for real flats. */
export function calculateElevationMetrics(profile, options = {}) {
  const samples = profileSamples(profile);
  if (!samples) return {};
  const smoothed = smoothElevationProfile(samples, options);
  let ascent = 0;
  let descent = 0;
  let maxGrade = 0;

  for (let index = 1; index < smoothed.length; index += 1) {
    const elevationChange = smoothed[index].elevationMeters -
      smoothed[index - 1].elevationMeters;
    const distance = smoothed[index].distanceMeters - smoothed[index - 1].distanceMeters;
    if (elevationChange > 0) ascent += elevationChange;
    if (elevationChange < 0) descent -= elevationChange;
    if (distance > 0) maxGrade = Math.max(maxGrade, Math.abs(elevationChange) / distance * 100);
  }

  const elevations = samples.map(({ elevationMeters }) => elevationMeters);
  return {
    ascentForwardMeters: rounded(ascent),
    descentForwardMeters: rounded(descent),
    minElevationMeters: rounded(Math.min(...elevations)),
    maxElevationMeters: rounded(Math.max(...elevations)),
    maxGradePct: rounded(maxGrade),
  };
}

export const elevationMetrics = calculateElevationMetrics;

/**
 * Replace any upstream elevation values with Alpine Search metrics. Incomplete
 * profiles remove all metric fields instead of leaving stale values or zeros.
 */
export function applyElevationMetrics(segment, profile, options = {}) {
  const enriched = { ...segment };
  for (const field of ELEVATION_METRIC_FIELDS) delete enriched[field];
  return { ...enriched, ...calculateElevationMetrics(profile, options) };
}
