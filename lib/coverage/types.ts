import { z } from "zod";
import { areaGeometrySchema } from "@/lib/contracts/routes";

export const coverageRequestSchema = z.object({
  collectionIds: z.array(z.string().min(1)).max(100).default([]),
  geometry: areaGeometrySchema.optional(),
  memoryLimitMiB: z.number().int().min(512).max(65536).default(4096),
  offline: z.boolean().default(false),
}).strict().refine((value) => value.collectionIds.length > 0 || value.geometry !== undefined, {
  message: "Choose a collection or draw an installation area",
});
export const coverageUnitSchema = z.object({
  id: z.string(), geometry: areaGeometrySchema,
  status: z.enum(["pending", "processing", "prepared", "installed", "unavailable"]),
  reason: z.string().optional(),
});
export const coverageCollectionSchema = z.object({
  id: z.string(), name: z.string(), geometry: areaGeometrySchema,
  sourceIds: z.array(z.string()), limitations: z.array(z.string()),
});
export const coveragePlanSchema = z.object({
  id: z.string(), request: coverageRequestSchema, geometry: areaGeometrySchema,
  units: z.array(coverageUnitSchema), sourceIds: z.array(z.string()),
  estimates: z.object({ downloadBytes: z.number().nonnegative().nullable(), temporaryBytes: z.number().nonnegative().nullable(), reusableBytes: z.number().nonnegative() }),
  warnings: z.array(z.string()),
});
export const coverageSnapshotSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), dataVersion: z.string(),
  geometry: areaGeometrySchema, unitIds: z.array(z.string()), createdAt: z.string(),
  sourceFingerprint: z.string(), auditStatus: z.literal("passed"),
  limitations: z.array(z.string()),
});
export type CoverageRequest = z.infer<typeof coverageRequestSchema>;
export type CoverageUnit = z.infer<typeof coverageUnitSchema>;
export type CoverageCollection = z.infer<typeof coverageCollectionSchema>;
export type CoveragePlan = z.infer<typeof coveragePlanSchema>;
export type CoverageSnapshot = z.infer<typeof coverageSnapshotSchema>;

export type CoverageProgressUpdate = {
  stage?: string;
  units?: CoverageUnit[];
  completedUnits?: number;
  snapshot?: CoverageSnapshot | null;
};

export type CoverageRunnerContext = {
  signal: AbortSignal;
  /** Deprecated research-script input; coherent builds never publish partial data. */
  publishOnly?: boolean;
  report(update: CoverageProgressUpdate): Promise<void>;
  checkpoint(): Promise<"continue" | "pause" | "cancel" | "publish">;
};

export type CoverageRunResult = {
  snapshot: CoverageSnapshot | null;
  completedUnits: number;
  units: CoverageUnit[];
  status: "completed" | "paused";
};
