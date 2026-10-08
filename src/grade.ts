import type { GradeLimits, Position } from "./model.js";

export function validGradeLimits(value: unknown): value is GradeLimits {
  if (!value || typeof value !== "object") return false;
  return (["uphill", "downhill"] as const).every(direction => {
    const limit = (value as GradeLimits)[direction];
    return limit && (["above", "total", "longest"] as const).every(key =>
      typeof limit[key] === "number" && Number.isFinite(limit[key]) && limit[key] >= 0);
  });
}

export type ProfileSample = { distance: number; position: Position };

/** Horizontal distance uses the same Earth diameter as prepared trail lengths. */
function horizontalDistance(a: Position, b: Position): number {
  const radians = Math.PI / 180;
  const from = a[1] * radians, to = b[1] * radians;
  const h = Math.sin((to - from) / 2) ** 2 + Math.cos(from) * Math.cos(to)
    * Math.sin(((b[0] - a[0]) * radians) / 2) ** 2;
  return 12742017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function elevationSamples(geometry: Position[]): ProfileSample[] {
  let distance = 0;
  return geometry.map((position, index) => {
    const previous = geometry[index - 1];
    if (previous) distance += horizontalDistance(previous, position);
    return { distance, position };
  });
}

/** Packed cumulative distance/elevation pairs for search; unknown height is NaN. */
export function elevationProfile(geometry: Position[]): Float64Array {
  const profile = new Float64Array(geometry.length * 2);
  let distance = 0;
  for (let i = 0; i < geometry.length; i++) {
    if (i) distance += horizontalDistance(geometry[i - 1]!, geometry[i]!);
    profile[i * 2] = distance;
    profile[i * 2 + 1] = geometry[i]![2] ?? NaN;
  }
  return profile;
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
 * Packed input avoids per-point objects in search. Limits permit early rejection;
 * null then means either unknown/invalid elevation or an exceeded budget.
 */
export function gradeExposure(
  samples: ProfileSample[] | Float64Array,
  thresholds: { uphill: number; downhill: number },
  limits?: GradeLimits,
): GradeExposure | null {
  const result: GradeExposure = {
    uphill: { total: 0, longest: 0 },
    downhill: { total: 0, longest: 0 },
  };
  const profile = samples instanceof Float64Array ? samples : new Float64Array(samples.length * 2);
  if (!(samples instanceof Float64Array)) for (let i = 0; i < samples.length; i++) {
    profile[i * 2] = samples[i]!.distance;
    profile[i * 2 + 1] = samples[i]!.position[2] ?? NaN;
  }
  if (!profile.length || profile.length % 2 || profile[0] !== 0) return null;
  if (!Number.isFinite(thresholds.uphill) || thresholds.uphill < 0 ||
      !Number.isFinite(thresholds.downhill) || thresholds.downhill < 0) return null;
  for (let i = 0; i < profile.length; i += 2) {
    if (!Number.isFinite(profile[i]) || !Number.isFinite(profile[i + 1]) ||
        (i > 0 && profile[i]! < profile[i - 2]!)) return null;
  }
  const count = profile.length / 2, length = profile[profile.length - 2]!;
  if (!length) return result;
  // The two streams of shifted vertices are already sorted. Merge them while
  // advancing both window ends once through the profile: O(n), no sort or lookup.
  let minus = 0, plus = 0, before = 1, after = 1, left = 0;
  const directions = ["uphill", "downhill"] as const;
  const fractions = { uphill: thresholds.uphill / 100, downhill: thresholds.downhill / 100 };
  const runs = { uphill: 0, downhill: 0 };
  while (left < length) {
    while (minus < count && profile[minus * 2]! - 50 <= left) minus++;
    while (plus < count && profile[plus * 2]! + 50 <= left) plus++;
    const right = Math.min(length, minus < count ? profile[minus * 2]! - 50 : Infinity,
      plus < count ? profile[plus * 2]! + 50 : Infinity);
    const center = (left + right) / 2;
    const start = Math.max(0, center - 50);
    const end = Math.min(length, center + 50);
    while (before < count - 1 && profile[before * 2]! < start) before++;
    while (after < count - 1 && profile[after * 2]! < end) after++;
    const startSlope = start === 0 ? 0 : (profile[before * 2 + 1]! - profile[before * 2 - 1]!)
      / (profile[before * 2]! - profile[before * 2 - 2]!);
    const endSlope = end === length ? 0 : (profile[after * 2 + 1]! - profile[after * 2 - 1]!)
      / (profile[after * 2]! - profile[after * 2 - 2]!);
    const startHeight = start === 0 ? profile[1]! : profile[before * 2 - 1]!
      + (start - profile[before * 2 - 2]!) * startSlope;
    const endHeight = end === length ? profile[profile.length - 1]! : profile[after * 2 - 1]!
      + (end - profile[after * 2 - 2]!) * endSlope;
    const rise = endHeight - startHeight;
    const runSlope = Number(end < length) - Number(start > 0);
    for (const direction of directions) {
      const sign = direction === "uphill" ? 1 : -1;
      const threshold = fractions[direction];
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
      if (limits && (result[direction].total > limits[direction].total
        || result[direction].longest > limits[direction].longest)) return null;
      if (to < right) runs[direction] = 0;
    }
    left = right;
  }
  return result;
}
