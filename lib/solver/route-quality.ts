import type { ConstraintViolationV3, GeneratedClosedRouteV3 } from "@/lib/contracts";
import type { RouteSearchRequest } from "./types";

const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;
export type RouteQualityMetrics = Pick<GeneratedClosedRouteV3,
  "distanceMeters" | "elevationGainMeters" | "maximumElevationMeters" | "steepestSustainedGradePct" | "gradeExperience" | "trailNames">
  & { topology: Pick<GeneratedClosedRouteV3["topology"], "repeatedTrailFraction" | "sharedStemDistanceMeters">;
    startAccessPoint: Pick<GeneratedClosedRouteV3["startAccessPoint"], "confidence"> };

function violation(
  constraint: ConstraintViolationV3["constraint"],
  value: number,
  min: number,
  max: number,
): ConstraintViolationV3 | null {
  if (value >= min && value <= max) return null;
  const delta = value < min ? min - value : value - max;
  const scale = Math.max(Math.abs(max - min), Math.abs(min), Math.abs(max), 1);
  return { constraint, value, min, max, delta, normalizedDelta: delta / scale };
}

function centerDistance(value: number, min: number, max: number): number {
  return Math.abs(value - (min + max) / 2) / Math.max(Math.abs(max - min), Math.abs(min), Math.abs(max), 1);
}

export function rankRouteMetrics(route: RouteQualityMetrics, request: RouteSearchRequest) {
  const ranges: Array<{ constraint: ConstraintViolationV3["constraint"]; value: number; min: number; max: number }> = [{
    constraint: "distance",
    value: route.distanceMeters,
    min: request.distanceMiles.min * METERS_PER_MILE,
    max: request.distanceMiles.max * METERS_PER_MILE,
  }];
  if (request.elevationGainFeet) ranges.push({
    constraint: "elevation-gain",
    value: route.elevationGainMeters,
    min: request.elevationGainFeet.min * METERS_PER_FOOT,
    max: request.elevationGainFeet.max * METERS_PER_FOOT,
  });
  if (request.maximumElevationFeet) ranges.push({
    constraint: "maximum-elevation",
    value: route.maximumElevationMeters,
    min: request.maximumElevationFeet.min * METERS_PER_FOOT,
    max: request.maximumElevationFeet.max * METERS_PER_FOOT,
  });
  if (request.steepestSustainedGradePct) ranges.push({
    constraint: "steepest-sustained-grade",
    value: route.steepestSustainedGradePct,
    min: request.steepestSustainedGradePct.min,
    max: request.steepestSustainedGradePct.max,
  });
  if (request.gradeExperience && route.gradeExperience) {
    ranges.push(
      { constraint: "climb-p90-grade", value: route.gradeExperience.climbP90Pct, min: 0, max: request.gradeExperience.maximumClimbP90Pct },
      { constraint: "steep-climbing-share", value: route.gradeExperience.steepClimbingSharePct, min: 0, max: request.gradeExperience.maximumSteepClimbingSharePct },
      { constraint: "longest-steep-climb", value: route.gradeExperience.longestSteepClimbMeters, min: 0, max: request.gradeExperience.maximumSteepRunMiles * METERS_PER_MILE },
      { constraint: "descent-p90-grade", value: route.gradeExperience.descentP90Pct, min: 0, max: request.gradeExperience.maximumDescentP90Pct },
    );
  }
  ranges.push({
    constraint: "repeated-trail",
    value: route.topology.repeatedTrailFraction * 100,
    min: 0,
    max: request.closedRoute.maximumRepeatedTrailPct,
  });
  if (request.closedRoute.maximumSharedStemMiles !== undefined) ranges.push({
    constraint: "shared-stem",
    value: route.topology.sharedStemDistanceMeters,
    min: 0,
    max: request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE,
  });
  const violations = ranges
    .map((range) => violation(range.constraint, range.value, range.min, range.max))
    .filter((item): item is ConstraintViolationV3 => item !== null);
  const centerScore = ranges
    .filter(({ constraint }) => constraint !== "repeated-trail" && constraint !== "shared-stem")
    .reduce((sum, range) => sum + centerDistance(range.value, range.min, range.max), 0);
  return {
    exact: violations.length === 0,
    violations,
    score: centerScore
      + route.topology.repeatedTrailFraction
      + route.topology.sharedStemDistanceMeters / Math.max(route.distanceMeters, 1)
      + Math.max(0, route.trailNames.length - 1) * 0.03
      + ({ high: 0, medium: 0.1, low: 0.2 }[route.startAccessPoint.confidence]),
  };
}

