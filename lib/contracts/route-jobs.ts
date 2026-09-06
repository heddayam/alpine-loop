import { z } from "zod";
import { finiteNumberSchema, isoDateSchema } from "./common";
import { originSchema } from "./discovery";
import {
  areaGeometrySchema,
  bboxSchema,
  constraintViolationV3Schema,
  driveTimeDurationSchema,
  generatedClosedRouteV3Schema,
  routeCriteriaSchema,
} from "./routes";

export const createBatchRouteJobV1Schema = z.object({
  version: z.literal(1),
  packId: z.string().trim().min(1),
  origin: originSchema.optional(),
  durationMinutes: driveTimeDurationSchema.optional(),
  searchRegionId: z.string().trim().min(1).optional(),
  drawnAreaBbox: bboxSchema.optional(),
  criteria: routeCriteriaSchema,
  routesPerAccessPoint: z.literal(10),
}).strict().superRefine((request, context) => {
  if (Boolean(request.origin) !== Boolean(request.durationMinutes)) {
    context.addIssue({
      code: "custom",
      path: request.origin ? ["durationMinutes"] : ["origin"],
      message: "Origin and drive time must be provided together",
    });
  }
  if (Boolean(request.searchRegionId) === Boolean(request.drawnAreaBbox)) {
    context.addIssue({
      code: "custom",
      path: request.drawnAreaBbox ? ["searchRegionId"] : ["drawnAreaBbox"],
      message: "Choose exactly one reviewed region or drawn area",
    });
  }
  if (request.drawnAreaBbox && (request.origin || request.durationMinutes !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["drawnAreaBbox"],
      message: "A drawn area cannot be combined with origin or drive time",
    });
  }
});

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

export type CreateBatchRouteJobV1 = z.infer<typeof createBatchRouteJobV1Schema>;
export type RouteJobStatus = z.infer<typeof routeJobStatusSchema>;
export type RouteJobProgress = z.infer<typeof routeJobProgressSchema>;
export type RouteJob = z.infer<typeof routeJobSchema>;
export type RouteJobResult = z.infer<typeof routeJobResultSchema>;
export type RouteJobResultsPage = z.infer<typeof routeJobResultsPageSchema>;
