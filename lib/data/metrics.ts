import type { ElevationSampler } from "./adapters";
import type { Coordinate } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_SAMPLE_SPACING_M = 25;
const ELEVATION_NOISE_THRESHOLD_M = 1;
const SUSTAINED_GRADE_WINDOW_M = 100;

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

export async function calculateEdgeMetrics(
  geometry: readonly Coordinate[],
  sampler: ElevationSampler,
): Promise<EdgeMetrics> {
  const coordinates = densifyGeometry(geometry);
  const samples = await sampler.sample(coordinates);
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

  let maxSustainedGradePct = 0;
  for (let start = 0; start < distances.length - 1; start += 1) {
    let end = start + 1;
    while (end < distances.length - 1 && distances[end] - distances[start] < SUSTAINED_GRADE_WINDOW_M) end += 1;
    const runM = distances[end] - distances[start];
    if (runM <= 0) continue;
    maxSustainedGradePct = Math.max(
      maxSustainedGradePct,
      Math.abs(samples[end] - samples[start]) / runM * 100,
    );
  }

  return {
    lengthM,
    gainM,
    lossM,
    maxElevationM: Math.max(...samples),
    maxSustainedGradePct,
    samples,
  };
}
