import { z } from "zod";
import { finiteNumberSchema } from "./common";

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

export type RouteJobStatus = z.infer<typeof routeJobStatusSchema>;
export type RouteJobProgress = z.infer<typeof routeJobProgressSchema>;
