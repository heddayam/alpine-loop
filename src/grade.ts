import type { Position } from "./model.js";

export type ProfileSample = { distance: number; position: Position };

/** Horizontal distance uses the same Earth diameter as prepared trail lengths. */
export function elevationSamples(geometry: Position[]): ProfileSample[] {
  let distance = 0;
  const radians = Math.PI / 180;
  return geometry.map((position, index) => {
    const previous = geometry[index - 1];
    if (previous) {
      const a = previous[1] * radians;
      const b = position[1] * radians;
      const h =
        Math.sin((b - a) / 2) ** 2 +
        Math.cos(a) *
          Math.cos(b) *
          Math.sin(((position[0] - previous[0]) * radians) / 2) ** 2;
      distance += 12742017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return { distance, position };
  });
}

function finitePosition(position: Position): Position {
  return Number.isFinite(position[2])
    ? [...position]
    : [position[0], position[1]];
}

function sampleIndex(samples: ProfileSample[], distance: number): number {
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle]!.distance < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Repeated trail segments remain separate positions along the ordered walk. */
export function elevationPosition(
  samples: ProfileSample[],
  distance: number,
): Position | null {
  if (!samples.length) return null;
  if (distance <= 0) return finitePosition(samples[0]!.position);
  if (distance >= samples.at(-1)!.distance)
    return finitePosition(samples.at(-1)!.position);
  const index = sampleIndex(samples, distance);
  const after = samples[index]!;
  if (after.distance === distance) return finitePosition(after.position);
  const before = samples[index - 1]!;
  const fraction =
    (distance - before.distance) / (after.distance - before.distance);
  const a = before.position;
  const b = after.position;
  const longitude = a[0] + (((b[0] - a[0] + 540) % 360) - 180) * fraction;
  const position: Position = [
    ((longitude + 540) % 360) - 180,
    a[1] + (b[1] - a[1]) * fraction,
  ];
  if (Number.isFinite(a[2]) && Number.isFinite(b[2])) {
    position.push(a[2]! + (b[2]! - a[2]!) * fraction);
  }
  return position;
}

/** Signed rise/run over a 100 m window, clipped at the walk's endpoints. */
export function elevationGrade(
  samples: ProfileSample[],
  distance: number,
): number | null {
  const total = samples.at(-1)?.distance ?? 0;
  if (!total || !Number.isFinite(distance)) return null;
  const center = Math.max(0, Math.min(total, distance));
  const start = Math.max(0, center - 50);
  const end = Math.min(total, center + 50);
  const a = elevationPosition(samples, start)?.[2];
  const b = elevationPosition(samples, end)?.[2];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  for (
    let i = sampleIndex(samples, start);
    i < samples.length && samples[i]!.distance < end;
    i++
  ) {
    if (!Number.isFinite(samples[i]!.position[2])) return null;
  }
  return ((b! - a!) / (end - start)) * 100;
}

export type GradeExposure = {
  uphill: { total: number; longest: number };
  downhill: { total: number; longest: number };
};

/** Distance exposed to signed 100 m grade, preserving the ordered walk.
 * Unknown elevations invalidate the result. Each interval is integrated exactly:
 * window ends move linearly between shifted elevation vertices, and threshold
 * crossings solve rise - threshold * run = 0 (also at clipped endpoints).
 */
export function gradeExposure(
  samples: ProfileSample[],
  thresholds: { uphill: number; downhill: number },
): GradeExposure | null {
  const result: GradeExposure = {
    uphill: { total: 0, longest: 0 },
    downhill: { total: 0, longest: 0 },
  };
  if (!samples.length || samples[0]!.distance !== 0) return null;
  if (!Number.isFinite(thresholds.uphill) || thresholds.uphill < 0 ||
      !Number.isFinite(thresholds.downhill) || thresholds.downhill < 0) return null;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    if (!Number.isFinite(sample.distance) || !Number.isFinite(sample.position[2]) ||
        (i > 0 && sample.distance < samples[i - 1]!.distance)) return null;
  }
  const length = samples.at(-1)!.distance;
  if (!length) return result;
  const breaks = new Set([0, length]);
  for (const sample of samples) {
    for (const value of [sample.distance - 50, sample.distance + 50]) {
      if (value > 0 && value < length) breaks.add(value);
    }
  }
  const points = [...breaks].sort((a, b) => a - b);
  // At an interior interval's midpoint, duplicates can never cause a zero run.
  const slope = (distance: number) => {
    const i = sampleIndex(samples, distance);
    const a = samples[i - 1]!;
    const b = samples[i]!;
    return (b.position[2]! - a.position[2]!) / (b.distance - a.distance);
  };
  const runs = { uphill: 0, downhill: 0 };
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1]!;
    const right = points[i]!;
    const center = (left + right) / 2;
    const start = Math.max(0, center - 50);
    const end = Math.min(length, center + 50);
    const rise = elevationPosition(samples, end)![2]! - elevationPosition(samples, start)![2]!;
    const startSlope = start === 0 ? 0 : slope(start);
    const endSlope = end === length ? 0 : slope(end);
    const runSlope = Number(end < length) - Number(start > 0);
    for (const direction of ["uphill", "downhill"] as const) {
      const sign = direction === "uphill" ? 1 : -1;
      const threshold = thresholds[direction] / 100;
      const value = sign * rise - threshold * (end - start);
      const derivative = sign * (endSlope - startSlope) - threshold * runSlope;
      const atLeft = value + derivative * (left - center);
      const atRight = value + derivative * (right - center);
      let from = left;
      let to = right;
      if (atLeft <= 0 && atRight <= 0) {
        runs[direction] = 0;
        continue;
      }
      if (atLeft < 0) from = center - value / derivative;
      if (atRight < 0) to = center - value / derivative;
      if (from > left) runs[direction] = 0;
      const distance = to - from;
      result[direction].total += distance;
      runs[direction] += distance;
      result[direction].longest = Math.max(result[direction].longest, runs[direction]);
      if (to < right) runs[direction] = 0;
    }
  }
  return result;
}
