import {
  generateRoutesRequestV2Schema,
  type AccessFilterV2,
  type GenerateRoutesRequestV2,
} from "@/lib/contracts";
import { FIXTURE_PACK_METADATA } from "@/lib/packs/fixture-pack";
import type { Bounds, BuilderValues, RangeField } from "./types";

export type ValidationResult =
  | { success: true; request: GenerateRoutesRequestV2 }
  | { success: false; errors: string[] };

function parseRange(field: RangeField, label: string) {
  if (!field.enabled) return { value: undefined, errors: [] };
  const min = Number(field.min);
  const max = Number(field.max);
  const errors: string[] = [];
  if (!Number.isFinite(min) || !Number.isFinite(max)) errors.push(`${label} must use finite numbers.`);
  else {
    if (min < 0 || max < 0) errors.push(`${label} cannot be negative.`);
    if (min > max) errors.push(`${label} minimum must not exceed its maximum.`);
  }
  return { value: { min, max }, errors };
}

export function isPointInsideBounds(lon: number, lat: number, bounds: Bounds) {
  const [west, south, east, north] = bounds;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

export function isBoundsInsideBounds(inner: Bounds, outer: Bounds) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export function buildGenerateRoutesRequest(
  values: BuilderValues,
  accessFilter: AccessFilterV2 | null,
  startAccessPointId?: string,
  packId = FIXTURE_PACK_METADATA.id,
): ValidationResult {
  const errors: string[] = [];
  if (!accessFilter) errors.push("Choose and complete a trailhead filter first.");
  if (values.routeTypes.length === 0) errors.push("Choose at least one route shape.");

  const distance = parseRange(values.distanceMiles, "Distance");
  const elevationGain = parseRange(values.elevationGainFeet, "Elevation gain");
  const maximumElevation = parseRange(values.maximumElevationFeet, "Maximum elevation");
  const steepestGrade = parseRange(values.steepestSustainedGradePct, "Steepest sustained grade");
  errors.push(...distance.errors, ...elevationGain.errors, ...maximumElevation.errors, ...steepestGrade.errors);
  if (distance.value && distance.value.max > 30) errors.push("Route distance may not exceed 30 miles.");

  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) errors.push("Route count must be a whole number from 1 through 20.");
  if (errors.length || !accessFilter || !distance.value) return { success: false, errors };

  const candidate: GenerateRoutesRequestV2 = {
    version: 2,
    packId,
    accessFilter,
    ...(startAccessPointId ? { startAccessPointId } : {}),
    routeTypes: values.routeTypes,
    pointToPoint: { finishMustMatchAccessFilter: values.pointToPointFinishMustMatchAccessFilter },
    distanceMiles: distance.value,
    ...(elevationGain.value ? { elevationGainFeet: elevationGain.value } : {}),
    ...(maximumElevation.value ? { maximumElevationFeet: maximumElevation.value } : {}),
    ...(steepestGrade.value ? { steepestSustainedGradePct: steepestGrade.value } : {}),
    includeUncertainAccess: values.includeUncertainAccess,
    limit,
  };
  const parsed = generateRoutesRequestV2Schema.safeParse(candidate);
  return parsed.success
    ? { success: true, request: parsed.data }
    : { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
}
