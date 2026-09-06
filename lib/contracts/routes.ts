import { z } from "zod";
import { accessStateSchema, confidenceSchema, finiteNumberSchema, isoDateSchema, orderedRangeSchema } from "./common";

export const DRIVE_TIME_DURATIONS_MINUTES = [
  5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60,
  75, 90, 105, 120, 135, 150, 165, 180, 210, 240, 270, 300,
] as const;

export const driveTimeDurationSchema = z.number().int().refine(
  (value) => (DRIVE_TIME_DURATIONS_MINUTES as readonly number[]).includes(value),
  { message: "Drive time must be one of the supported values from 5 through 300 minutes" },
);

const coordinateSchema = z.tuple([finiteNumberSchema, finiteNumberSchema]).refine(
  ([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90,
  { message: "Area coordinate is outside valid longitude/latitude ranges" },
);
const linearRingSchema = z.array(coordinateSchema).min(4).refine(
  (ring) => ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1],
  { message: "Area rings must be closed" },
);

export const polygonGeometrySchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(linearRingSchema).min(1),
}).strict();

export const multiPolygonGeometrySchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(linearRingSchema).min(1)).min(1),
}).strict();

export const areaGeometrySchema = z.union([polygonGeometrySchema, multiPolygonGeometrySchema]);

export const bboxSchema = z
  .tuple([finiteNumberSchema, finiteNumberSchema, finiteNumberSchema, finiteNumberSchema])
  .refine(([west, south, east, north]) => west < east && south < north, {
    message: "Bounding box must have positive width and height",
  })
  .refine(([west, south, east, north]) => west >= -180 && east <= 180 && south >= -90 && north <= 90, {
    message: "Bounding box coordinates are outside valid longitude/latitude ranges",
  });

export const accessFilterV2Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("drawn-area"), bbox: bboxSchema }).strict(),
  z.object({ mode: z.literal("named-region"), regionId: z.string().trim().min(1) }).strict(),
  z.object({
    mode: z.literal("drive-time"),
    reachabilityId: z.string().uuid(),
    regionId: z.string().trim().min(1).optional(),
  }).strict(),
]);

export const closedRouteTopologyPreferenceV3Schema = z.object({
  maximumRepeatedTrailPct: z.number().int().min(0).max(100),
  maximumSharedStemMiles: finiteNumberSchema.nonnegative().max(30).optional(),
  allowMultiCycle: z.boolean(),
}).strict();

export const searchEffortV3Schema = z.enum(["quick", "thorough"]);

export const GRADE_WINDOW_METERS = 100;
export const STEEP_GRADE_THRESHOLD_PCT = 10;

export const gradeExperienceConstraintsSchema = z.object({
  maximumClimbP90Pct: finiteNumberSchema.nonnegative().max(100),
  maximumSteepClimbingSharePct: finiteNumberSchema.min(0).max(100),
  maximumSteepRunMiles: finiteNumberSchema.nonnegative().max(30),
  maximumDescentP90Pct: finiteNumberSchema.nonnegative().max(100),
}).strict();

export const gradeExperienceMetricsSchema = z.object({
  climbP90Pct: finiteNumberSchema.nonnegative(),
  steepClimbingSharePct: finiteNumberSchema.min(0).max(100),
  longestSteepClimbMeters: finiteNumberSchema.nonnegative(),
  descentP90Pct: finiteNumberSchema.nonnegative(),
  windowMeters: z.literal(GRADE_WINDOW_METERS),
  steepThresholdPct: z.literal(STEEP_GRADE_THRESHOLD_PCT),
}).strict();

export const routeCriteriaSchema = z.object({
  closedRoute: closedRouteTopologyPreferenceV3Schema,
  distanceMiles: orderedRangeSchema.refine(({ max }) => max <= 30, {
    message: "Route distance may not exceed 30 miles",
  }),
  elevationGainFeet: orderedRangeSchema.optional(),
  maximumElevationFeet: orderedRangeSchema.optional(),
  steepestSustainedGradePct: orderedRangeSchema.optional(),
  gradeExperience: gradeExperienceConstraintsSchema.optional(),
  includeUncertainAccess: z.boolean(),
}).strict();

export type RouteCriteria = z.infer<typeof routeCriteriaSchema>;

export const generateClosedRoutesRequestV3Schema = routeCriteriaSchema.extend({
  version: z.literal(3),
  packId: z.string().trim().min(1),
  accessFilter: accessFilterV2Schema,
  startAccessPointId: z.string().trim().min(1).optional(),
  routeFamily: z.literal("closed"),
  searchEffort: searchEffortV3Schema,
  limit: z.number().int().min(1).max(20),
}).strict();

const positionSchema = z.tuple([finiteNumberSchema, finiteNumberSchema]);
export const lineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(positionSchema).min(2),
}).strict();

export const routeAccessPointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lon: finiteNumberSchema,
  lat: finiteNumberSchema,
  accessState: accessStateSchema,
  confidence: confidenceSchema,
}).strict();

export const elevationSampleSchema = z.object({
  distanceMeters: finiteNumberSchema.nonnegative(),
  elevationMeters: finiteNumberSchema,
}).strict();

export const trailSegmentConditionSchema = z.object({
  highway: z.string().trim().min(1).optional(),
  surface: z.string().trim().min(1).optional(),
  smoothness: z.string().trim().min(1).optional(),
  trailVisibility: z.string().trim().min(1).optional(),
  sacScale: z.string().trim().min(1).optional(),
  informal: z.boolean().optional(),
  lifecycle: z.enum(["disused", "abandoned"]).optional(),
}).strict();

export const generatedTrailSegmentSchema = z.object({
  id: z.string().min(1),
  geometry: lineStringSchema,
  name: z.string().trim().min(1).nullable(),
  distanceMeters: finiteNumberSchema.positive(),
  startDistanceMeters: finiteNumberSchema.nonnegative(),
  endDistanceMeters: finiteNumberSchema.positive(),
  accessState: accessStateSchema,
  condition: trailSegmentConditionSchema,
  sourceFeatureId: z.string().trim().min(1).optional(),
  sourceIds: z.array(z.string().trim().min(1)).min(1),
}).strict().refine(
  ({ startDistanceMeters, endDistanceMeters }) => endDistanceMeters > startDistanceMeters,
  { message: "Trail segment end distance must follow its start distance" },
);

const generatedClosedRouteBaseSchema = z.object({
  id: z.string().min(1),
  geometry: lineStringSchema,
  startAccessPoint: routeAccessPointSchema,
  distanceMeters: finiteNumberSchema.nonnegative(),
  elevationGainMeters: finiteNumberSchema.nonnegative(),
  elevationLossMeters: finiteNumberSchema.nonnegative(),
  minimumElevationMeters: finiteNumberSchema,
  maximumElevationMeters: finiteNumberSchema,
  steepestSustainedGradePct: finiteNumberSchema.nonnegative(),
  gradeExperience: gradeExperienceMetricsSchema.optional(),
  trailNames: z.array(z.string().min(1)),
  /** Optional while persisted jobs created before segment inspection remain readable. */
  trailSegments: z.array(generatedTrailSegmentSchema).min(1).optional(),
  warnings: z.array(z.string()),
  source: z.object({
    freshness: isoDateSchema,
    confidence: confidenceSchema,
    sourceIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  elevationSamples: z.array(elevationSampleSchema).optional(),
}).strict();

export const closedRouteTopologyV3Schema = z.object({
  kind: z.enum(["simple-loop", "lollipop", "figure-eight", "chained-loops", "complex-closed"]),
  cycleCount: z.number().int().positive(),
  cycleBlockCount: z.number().int().positive(),
  repeatedTrailDistanceMeters: finiteNumberSchema.nonnegative(),
  repeatedTrailFraction: finiteNumberSchema.min(0).max(1),
  sharedStemDistanceMeters: finiteNumberSchema.nonnegative(),
  connectorCount: z.number().int().nonnegative(),
}).strict();

export const generatedClosedRouteV3Schema = generatedClosedRouteBaseSchema.extend({
  topology: closedRouteTopologyV3Schema,
}).strict();

export const constraintViolationSchema = z.object({
  constraint: z.enum(["distance", "elevation-gain", "maximum-elevation", "steepest-sustained-grade"]),
  value: finiteNumberSchema,
  min: finiteNumberSchema,
  max: finiteNumberSchema,
  delta: finiteNumberSchema.nonnegative(),
  normalizedDelta: finiteNumberSchema.nonnegative(),
}).strict();

export const constraintViolationV3Schema = constraintViolationSchema.extend({
  constraint: z.enum([
    "distance",
    "elevation-gain",
    "maximum-elevation",
    "steepest-sustained-grade",
    "climb-p90-grade",
    "steep-climbing-share",
    "longest-steep-climb",
    "descent-p90-grade",
    "repeated-trail",
    "shared-stem",
  ]),
}).strict();

export const resolvedAccessFilterV2Schema = z.object({
  mode: z.enum(["drawn-area", "named-region", "drive-time"]),
  label: z.string().min(1),
  region: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict().optional(),
  driveTime: z.object({
    minutes: driveTimeDurationSchema,
    provider: z.literal("arcgis"),
    resolvedAt: isoDateSchema,
    originLabel: z.string().min(1),
  }).strict().optional(),
}).strict();

export const diagnosticsV2Schema = z.object({
  elapsedMs: finiteNumberSchema.nonnegative(),
  expandedStates: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  eligibleAccessPointCount: z.number().int().nonnegative(),
  searchedAccessPointCount: z.number().int().nonnegative(),
  graphQueryCount: z.number().int().nonnegative(),
  maximumLoadedDirectedEdges: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  truncationReasons: z.array(z.string()),
  shortfallReasons: z.array(z.string()),
}).strict();

export const closedRouteDiagnosticsV3Schema = diagnosticsV2Schema.extend({
  noCycleAccessPointCount: z.number().int().nonnegative(),
  feasibleAccessPointCount: z.number().int().nonnegative(),
  attachmentGroupCount: z.number().int().nonnegative(),
  probedAttachmentGroupCount: z.number().int().nonnegative(),
  deeplySearchedAttachmentGroupCount: z.number().int().nonnegative(),
  loadedTopologyNetworkCount: z.number().int().nonnegative(),
  cycleBlockCount: z.number().int().nonnegative(),
  cyclePrimitiveCount: z.number().int().nonnegative(),
  composedCandidateCount: z.number().int().nonnegative(),
  repairedCandidateCount: z.number().int().nonnegative(),
  directedValidationRejectionCount: z.number().int().nonnegative(),
  expandedAssemblyStates: z.number().int().nonnegative(),
  timeToFirstExactMs: finiteNumberSchema.nonnegative().optional(),
  hardTruncationReasons: z.array(z.string()),
  nonBudgetShortfallReasons: z.array(z.string()),
}).strict();

export const generateClosedRoutesResponseV3Schema = z.object({
  version: z.literal(3),
  requestId: z.string().min(1),
  pack: z.object({
    id: z.string().min(1),
    schemaVersion: z.enum(["3", "4", "5", "6"]),
    dataVersion: z.string().min(1),
    builtAt: isoDateSchema,
  }).strict(),
  requested: z.number().int().min(1).max(20),
  resolvedAccessFilter: resolvedAccessFilterV2Schema,
  exact: z.array(generatedClosedRouteV3Schema),
  nearMisses: z.array(generatedClosedRouteV3Schema.extend({
    violations: z.array(constraintViolationV3Schema).min(1),
  })).max(3),
  diagnostics: closedRouteDiagnosticsV3Schema,
}).strict();

export type AccessFilterV2 = z.infer<typeof accessFilterV2Schema>;
export type ClosedRouteTopologyPreferenceV3 = z.infer<typeof closedRouteTopologyPreferenceV3Schema>;
export type SearchEffortV3 = z.infer<typeof searchEffortV3Schema>;
export type GradeExperienceConstraints = z.infer<typeof gradeExperienceConstraintsSchema>;
export type GradeExperienceMetrics = z.infer<typeof gradeExperienceMetricsSchema>;
export type TrailSegmentCondition = z.infer<typeof trailSegmentConditionSchema>;
export type GeneratedTrailSegment = z.infer<typeof generatedTrailSegmentSchema>;
export type GenerateClosedRoutesRequestV3 = z.infer<typeof generateClosedRoutesRequestV3Schema>;
export type ClosedRouteTopologyV3 = z.infer<typeof closedRouteTopologyV3Schema>;
export type GeneratedClosedRouteV3 = z.infer<typeof generatedClosedRouteV3Schema>;
export type ConstraintViolation = z.infer<typeof constraintViolationSchema>;
export type ConstraintViolationV3 = z.infer<typeof constraintViolationV3Schema>;
export type ClosedRouteDiagnosticsV3 = z.infer<typeof closedRouteDiagnosticsV3Schema>;
export type GenerateClosedRoutesResponseV3 = z.infer<typeof generateClosedRoutesResponseV3Schema>;
