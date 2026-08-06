import type { ElevationSampler } from "./adapters";
import type { Coordinate } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_SAMPLE_SPACING_M = 25;
const ELEVATION_NOISE_THRESHOLD_M = 1;
export const SUSTAINED_GRADE_WINDOW_M = 100;

export type ElevationProfileSample = {
  distanceMeters: number;
  elevationMeters: number;
};

export type EdgeMetrics = {
  lengthM: number;
  gainM: number | null;
  lossM: number | null;
  maxElevationM: number | null;
  maxSustainedGradePct: number | null;
  samples: Array<number | null>;
};

export function distanceMeters([lon1, lat1]: Coordinate, [lon2, lat2]: Coordinate): number {
  const radians = Math.PI / 180;
  const phi1 = lat1 * radians;
  const phi2 = lat2 * radians;
  const deltaPhi = (lat2 - lat1) * radians;
  const deltaLambda = (lon2 - lon1) * radians;
  const a = Math.sin(deltaPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function densifyGeometry(coordinates: readonly Coordinate[]): Coordinate[] {
  if (coordinates.length < 2) throw new Error("Edge geometry needs at least two coordinates");
  const result: Coordinate[] = [coordinates[0]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const subdivisions = Math.max(1, Math.ceil(distanceMeters(start, end) / MAX_SAMPLE_SPACING_M));
    for (let step = 1; step <= subdivisions; step += 1) {
      const ratio = step / subdivisions;
      result.push([
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ]);
    }
  }
  return result;
}

function cumulativeDistances(coordinates: readonly Coordinate[]): number[] {
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    distances.push(distances[index - 1] + distanceMeters(coordinates[index - 1], coordinates[index]));
  }
  return distances;
}

function interpolatedElevation(
  before: ElevationProfileSample,
  after: ElevationProfileSample,
  distanceMeters: number,
): number {
  if (after.distanceMeters === distanceMeters) return after.elevationMeters;
  const ratio = (distanceMeters - before.distanceMeters) / (after.distanceMeters - before.distanceMeters);
  return before.elevationMeters + (after.elevationMeters - before.elevationMeters) * ratio;
}

/** Maximum absolute grade over an exact rolling window, never a shorter fragment. */
export function maximumSustainedGradePct(
  samples: readonly ElevationProfileSample[],
  windowMeters = SUSTAINED_GRADE_WINDOW_M,
): number | null {
  if (!Number.isFinite(windowMeters) || windowMeters <= 0) throw new Error("Sustained-grade window must be positive");
  if (samples.length < 2) return null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (!Number.isFinite(sample.distanceMeters) || !Number.isFinite(sample.elevationMeters)
      || (index > 0 && sample.distanceMeters <= samples[index - 1]!.distanceMeters)) {
      throw new Error("Elevation profile samples must be finite and strictly increasing by distance");
    }
  }
  const firstDistance = samples[0]!.distanceMeters;
  const finalDistance = samples.at(-1)!.distanceMeters;
  const finalStart = finalDistance - windowMeters;
  if (finalStart < firstDistance) return null;

  // For a piecewise-linear profile, extrema of f(x + window) - f(x) occur
  // where either endpoint crosses a profile sample. Two monotonic scans cover
  // those candidates in O(n), which matters when evaluating many routes.
  let maximum = 0;
  let endIndex = 1;
  for (const start of samples) {
    if (start.distanceMeters > finalStart) break;
    const endDistance = start.distanceMeters + windowMeters;
    while (samples[endIndex]!.distanceMeters < endDistance) endIndex += 1;
    maximum = Math.max(maximum, Math.abs(
      interpolatedElevation(samples[endIndex - 1]!, samples[endIndex]!, endDistance) - start.elevationMeters,
    ) / windowMeters * 100);
  }
  let startIndex = 1;
  for (const end of samples) {
    const startDistance = end.distanceMeters - windowMeters;
    if (startDistance < firstDistance) continue;
    while (samples[startIndex]!.distanceMeters < startDistance) startIndex += 1;
    maximum = Math.max(maximum, Math.abs(
      end.elevationMeters - interpolatedElevation(samples[startIndex - 1]!, samples[startIndex]!, startDistance),
    ) / windowMeters * 100);
  }
  return maximum;
}

export async function calculateEdgeMetrics(
  geometry: readonly Coordinate[],
  sampler: ElevationSampler,
): Promise<EdgeMetrics> {
  const coordinates = densifyGeometry(geometry);
  const samples = await sampler.sample(coordinates);
  return metricsFromSamples(coordinates, samples);
}

function metricsFromSamples(coordinates: Coordinate[], samples: Array<number | null>): EdgeMetrics {
  if (samples.length !== coordinates.length) {
    throw new Error(`Elevation sampler returned ${samples.length} values for ${coordinates.length} coordinates`);
  }
  const distances = cumulativeDistances(coordinates);
  const lengthM = distances.at(-1) ?? 0;
  const complete = samples.every((sample): sample is number => sample !== null);
  if (!complete) {
    return { lengthM, gainM: null, lossM: null, maxElevationM: null, maxSustainedGradePct: null, samples };
  }

  let gainM = 0;
  let lossM = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index] - samples[index - 1];
    if (Math.abs(delta) < ELEVATION_NOISE_THRESHOLD_M) continue;
    if (delta > 0) gainM += delta;
    else lossM += -delta;
  }

  const maxSustainedGradePct = maximumSustainedGradePct(distances.map((distanceMeters, index) => ({
    distanceMeters,
    elevationMeters: samples[index]!,
  })));

  return {
    lengthM,
    gainM,
    lossM,
    maxElevationM: Math.max(...samples),
    maxSustainedGradePct,
    samples,
  };
}

export async function calculateEdgeMetricsBatch(
  geometries: ReadonlyArray<readonly Coordinate[]>,
  sampler: ElevationSampler,
  batchSize = 5_000,
): Promise<EdgeMetrics[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Metric batch size must be a positive integer");
  const result: EdgeMetrics[] = [];
  for (let offset = 0; offset < geometries.length; offset += batchSize) {
    const dense = geometries.slice(offset, offset + batchSize).map(densifyGeometry);
    const flat = dense.flat();
    const samples = await sampler.sample(flat);
    if (samples.length !== flat.length) {
      throw new Error(`Elevation sampler returned ${samples.length} values for ${flat.length} batched coordinates`);
    }
    let sampleOffset = 0;
    for (const coordinates of dense) {
      const nextOffset = sampleOffset + coordinates.length;
      result.push(metricsFromSamples(coordinates, samples.slice(sampleOffset, nextOffset)));
      sampleOffset = nextOffset;
    }
  }
  return result;
}
