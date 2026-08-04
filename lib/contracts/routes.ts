import { z } from "zod";
import { accessStateSchema, confidenceSchema, finiteNumberSchema, isoDateSchema, orderedRangeSchema } from "./common";

export const routeTypeSchema = z.enum(["loop", "lollipop", "out-and-back", "point-to-point"]);

export const bboxSchema = z
  .tuple([finiteNumberSchema, finiteNumberSchema, finiteNumberSchema, finiteNumberSchema])
  .refine(([west, south, east, north]) => west < east && south < north, {
    message: "Bounding box must have positive width and height",
  })
  .refine(([west, south, east, north]) => west >= -180 && east <= 180 && south >= -90 && north <= 90, {
    message: "Bounding box coordinates are outside valid longitude/latitude ranges",
  });

export const generateRoutesRequestV1Schema = z.object({
  version: z.literal(1),
  packId: z.string().trim().min(1),
  bbox: bboxSchema,
  startAccessPointId: z.string().trim().min(1).optional(),
  routeTypes: z.array(routeTypeSchema).min(1).max(4),
  distanceMiles: orderedRangeSchema,
  elevationGainFeet: orderedRangeSchema.optional(),
  maximumElevationFeet: orderedRangeSchema.optional(),
  steepestSustainedGradePct: orderedRangeSchema.optional(),
  includeUncertainAccess: z.boolean(),
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

export const generatedRouteSchema = z.object({
  id: z.string().min(1),
  shape: routeTypeSchema,
  geometry: lineStringSchema,
  startAccessPoint: routeAccessPointSchema,
  endAccessPoint: routeAccessPointSchema,
  distanceMeters: finiteNumberSchema.nonnegative(),
  elevationGainMeters: finiteNumberSchema.nonnegative(),
  elevationLossMeters: finiteNumberSchema.nonnegative(),
  minimumElevationMeters: finiteNumberSchema,
  maximumElevationMeters: finiteNumberSchema,
  steepestSustainedGradePct: finiteNumberSchema.nonnegative(),
  repeatedEdgeFraction: finiteNumberSchema.min(0).max(1),
  trailNames: z.array(z.string().min(1)),
  warnings: z.array(z.string()),
  source: z.object({
    freshness: isoDateSchema,
    confidence: confidenceSchema,
    sourceIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  elevationSamples: z.array(elevationSampleSchema).optional(),
}).strict();

export const constraintViolationSchema = z.object({
  constraint: z.enum(["distance", "elevation-gain", "maximum-elevation", "steepest-sustained-grade"]),
  value: finiteNumberSchema,
  min: finiteNumberSchema,
  max: finiteNumberSchema,
  delta: finiteNumberSchema.nonnegative(),
  normalizedDelta: finiteNumberSchema.nonnegative(),
}).strict();

export const generateRoutesResponseV1Schema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1),
  pack: z.object({
    id: z.string().min(1),
    schemaVersion: z.string().min(1),
    dataVersion: z.string().min(1),
    builtAt: isoDateSchema,
  }).strict(),
  requested: z.number().int().min(1).max(20),
  exact: z.array(generatedRouteSchema),
  nearMisses: z.array(generatedRouteSchema.extend({ violations: z.array(constraintViolationSchema).min(1) })).max(3),
  diagnostics: z.object({
    elapsedMs: finiteNumberSchema.nonnegative(),
    expandedStates: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    truncationReasons: z.array(z.string()),
  }).strict(),
}).strict();

export type RouteType = z.infer<typeof routeTypeSchema>;
export type GenerateRoutesRequestV1 = z.infer<typeof generateRoutesRequestV1Schema>;
export type GeneratedRoute = z.infer<typeof generatedRouteSchema>;
export type ConstraintViolation = z.infer<typeof constraintViolationSchema>;
export type GenerateRoutesResponseV1 = z.infer<typeof generateRoutesResponseV1Schema>;
