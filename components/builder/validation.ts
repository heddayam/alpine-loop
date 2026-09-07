import { routeCriteriaSchema, type RouteCriteria } from "@/lib/contracts";
import type { BuilderValues, RangeField } from "./types";

type ValidationResult =
  | { success: true; criteria: RouteCriteria; limit: number }
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

export function parseSearchCriteria(values: BuilderValues): ValidationResult {
  const errors: string[] = [];
  const distance = parseRange(values.distanceMiles, "Distance");
  const elevationGain = parseRange(values.elevationGainFeet, "Elevation gain");
  const maximumElevation = parseRange(values.maximumElevationFeet, "Maximum elevation");
  errors.push(...distance.errors, ...elevationGain.errors, ...maximumElevation.errors);
  if (distance.value && distance.value.max > 30) errors.push("Route distance may not exceed 30 miles.");

  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) errors.push("Route count must be a whole number from 1 through 20.");
  const maximumRepeatedTrailPct = Number(values.maximumRepeatedTrailPct);
  if (!values.maximumRepeatedTrailPct.trim() || !Number.isInteger(maximumRepeatedTrailPct) || maximumRepeatedTrailPct < 0 || maximumRepeatedTrailPct > 100) {
    errors.push("Maximum repeated trail must be a whole percentage from 0 through 100.");
  }
  const maximumSharedStemMiles = Number(values.maximumSharedStemMiles);
  if (values.maximumSharedStemEnabled && (!values.maximumSharedStemMiles.trim() || !Number.isFinite(maximumSharedStemMiles) || maximumSharedStemMiles < 0 || maximumSharedStemMiles > 30)) {
    errors.push("Maximum shared approach must be from 0 through 30 miles.");
  }
  if (errors.length || !distance.value) return { success: false, errors };

  const candidate: RouteCriteria = {
    closedRoute: {
      maximumRepeatedTrailPct,
      ...(values.maximumSharedStemEnabled ? { maximumSharedStemMiles } : {}),
      allowMultiCycle: values.allowMultiCycle,
    },
    distanceMiles: distance.value,
    ...(elevationGain.value ? { elevationGainFeet: elevationGain.value } : {}),
    ...(maximumElevation.value ? { maximumElevationFeet: maximumElevation.value } : {}),
    ...(values.gradeConstraintEnabled ? { gradeExperience: values.gradePresets[values.selectedGradePreset] } : {}),
    includeUncertainAccess: values.includeUncertainAccess,
  };
  const parsed = routeCriteriaSchema.safeParse(candidate);
  return parsed.success
    ? { success: true, criteria: parsed.data, limit }
    : { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
}
