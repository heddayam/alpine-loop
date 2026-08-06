import { z } from "zod";
import { finiteNumberSchema, isoDateSchema, orderedRangeSchema } from "./common";
import { originSchema } from "./discovery";
import {
  accessPointRemotenessSelectionSchema,
  areaGeometrySchema,
  closedRouteTopologyPreferenceV3Schema,
  constraintViolationV3Schema,
  driveTimeDurationSchema,
  generatedClosedRouteV3Schema,
} from "./routes";

export const batchRouteCriteriaV1Schema = z.object({
  closedRoute: closedRouteTopologyPreferenceV3Schema,
  distanceMiles: orderedRangeSchema.refine(({ max }) => max <= 30, {
    message: "Route distance may not exceed 30 miles",
  }),
  elevationGainFeet: orderedRangeSchema.optional(),
  maximumElevationFeet: orderedRangeSchema.optional(),
  steepestSustainedGradePct: orderedRangeSchema.optional(),
  includeUncertainAccess: z.boolean(),
  accessPointRemoteness: accessPointRemotenessSelectionSchema,
}).strict();

export const createBatchRouteJobV1Schema = z.object({
  version: z.literal(1),
  packId: z.string().trim().min(1),
  origin: originSchema,
  durationMinutes: driveTimeDurationSchema,
  searchRegionId: z.string().trim().min(1),
  criteria: batchRouteCriteriaV1Schema,
  routesPerAccessPoint: z.literal(10),
}).strict();

export const routeJobStatusSchema = z.enum([
  "queued",
  "resolving-drive-time",
  "running",
  "completed",
  "cancelled",
  "failed",
  "deleting",
]);

export const routeJobProgressSchema = z.object({
  eligibleAccessPointCount: z.number().int().nonnegative(),
  processedAccessPointCount: z.number().int().nonnegative(),
  exactRouteCount: z.number().int().nonnegative(),
  nearMissRouteCount: z.number().int().nonnegative(),
  truncatedAccessPointCount: z.number().int().nonnegative(),
  elapsedMs: finiteNumberSchema.nonnegative(),
}).strict();

export const routeJobSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  status: routeJobStatusSchema,
  request: createBatchRouteJobV1Schema,
  pack: z.object({
    id: z.string().min(1),
    dataVersion: z.string().min(1),
    builtAt: isoDateSchema,
  }).strict(),
  searchRegion: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
  filterGeometry: areaGeometrySchema.optional(),
  progress: routeJobProgressSchema,
  partial: z.boolean(),
  stale: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  completedAt: isoDateSchema.optional(),
  error: z.string().min(1).optional(),
}).strict();

export const routeJobResultSchema = z.discriminatedUnion("matchType", [
  z.object({
    matchType: z.literal("exact"),
    accessPointId: z.string().min(1),
    route: generatedClosedRouteV3Schema,
  }).strict(),
  z.object({
    matchType: z.literal("near-miss"),
    accessPointId: z.string().min(1),
    route: generatedClosedRouteV3Schema.extend({
      violations: z.array(constraintViolationV3Schema).min(1),
    }).strict(),
  }).strict(),
]);

export const routeJobResultsPageSchema = z.object({
  version: z.literal(1),
  job: routeJobSchema,
  results: z.array(routeJobResultSchema).max(50),
  nextCursor: z.string().min(1).optional(),
}).strict();

export const routeJobListSchema = z.object({
  version: z.literal(1),
  jobs: z.array(routeJobSchema),
}).strict();

export type BatchRouteCriteriaV1 = z.infer<typeof batchRouteCriteriaV1Schema>;
export type CreateBatchRouteJobV1 = z.infer<typeof createBatchRouteJobV1Schema>;
export type RouteJobStatus = z.infer<typeof routeJobStatusSchema>;
export type RouteJobProgress = z.infer<typeof routeJobProgressSchema>;
export type RouteJob = z.infer<typeof routeJobSchema>;
export type RouteJobResult = z.infer<typeof routeJobResultSchema>;
export type RouteJobResultsPage = z.infer<typeof routeJobResultsPageSchema>;
