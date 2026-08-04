import {
  generateRoutesRequestV1Schema,
  type GenerateRoutesRequestV1,
} from "@/lib/contracts";
import type { Bounds, BuilderValues, RangeField } from "./types";

export type ValidationResult =
  | { success: true; request: GenerateRoutesRequestV1 }
  | { success: false; errors: string[] };

function parseRange(field: RangeField, label: string) {
  if (!field.enabled) return { value: undefined, errors: [] };

  const min = Number(field.min);
  const max = Number(field.max);
  const errors: string[] = [];
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    errors.push(`${label} must use finite numbers.`);
  } else {
    if (min < 0 || max < 0) errors.push(`${label} cannot be negative.`);
    if (min > max) errors.push(`${label} minimum must not exceed its maximum.`);
  }
  return { value: { min, max }, errors };
}

export function isPointInsideBounds(lon: number, lat: number, bounds: Bounds) {
  const [west, south, east, north] = bounds;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

export function buildGenerateRoutesRequest(
  values: BuilderValues,
  bounds: Bounds | null,
  startAccessPointId?: string,
): ValidationResult {
  const errors: string[] = [];
  if (!bounds) errors.push("Draw a search rectangle on the map first.");
  if (values.routeTypes.length === 0) errors.push("Choose at least one route shape.");

  const distance = parseRange(values.distanceMiles, "Distance");
  const elevationGain = parseRange(values.elevationGainFeet, "Elevation gain");
  const maximumElevation = parseRange(values.maximumElevationFeet, "Maximum elevation");
  const steepestGrade = parseRange(values.steepestSustainedGradePct, "Steepest sustained grade");
  errors.push(...distance.errors, ...elevationGain.errors, ...maximumElevation.errors, ...steepestGrade.errors);

  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    errors.push("Route count must be a whole number from 1 through 20.");
  }

  if (errors.length || !bounds || !distance.value) return { success: false, errors };

  const candidate: GenerateRoutesRequestV1 = {
    version: 1,
    packId: "fixture-pack",
    bbox: bounds,
    ...(startAccessPointId ? { startAccessPointId } : {}),
    routeTypes: values.routeTypes,
    distanceMiles: distance.value,
    ...(elevationGain.value ? { elevationGainFeet: elevationGain.value } : {}),
    ...(maximumElevation.value ? { maximumElevationFeet: maximumElevation.value } : {}),
    ...(steepestGrade.value ? { steepestSustainedGradePct: steepestGrade.value } : {}),
    includeUncertainAccess: values.includeUncertainAccess,
    limit,
  };
  const parsed = generateRoutesRequestV1Schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }
  return { success: true, request: parsed.data };
}
