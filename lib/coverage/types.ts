import { z } from "zod";
import { areaGeometrySchema } from "@/lib/contracts/routes";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { DataRelease } from "@/lib/contracts/releases";
import type { SourceRecipe } from "./recipe";

/** A named hiking area resolves all developer build inputs through one catalog. */
export type CoverageRegion = {
  id: string;
  name: string;
  geometry: AreaGeometry;
  recipe: SourceRecipe;
  aliases?: string[];
  sources?: DataRelease["sources"];
};

export const coverageUnitSchema = z.object({
  id: z.string(), geometry: areaGeometrySchema,
  status: z.enum(["pending", "processing", "prepared", "installed", "unavailable"]),
  reason: z.string().optional(),
});
export const coverageSnapshotSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), dataVersion: z.string(),
  geometry: areaGeometrySchema, unitIds: z.array(z.string()), createdAt: z.string(),
  sourceFingerprint: z.string(), auditStatus: z.literal("passed"),
  limitations: z.array(z.string()),
});
export type CoverageUnit = z.infer<typeof coverageUnitSchema>;
export type CoverageSnapshot = z.infer<typeof coverageSnapshotSchema>;

export type CoverageProgressUpdate = {
  stage?: string;
  units?: CoverageUnit[];
  completedUnits?: number;
  snapshot?: CoverageSnapshot | null;
  counts?: Record<string, number>;
  peakMeasuredMemoryBytes?: number;
  peakCgroupMemoryBytes?: number;
  peakDiskBytes?: number | null;
};

export type CoverageRunnerContext = {
  signal: AbortSignal;
  report(update: CoverageProgressUpdate): Promise<void>;
  checkpoint(): Promise<"continue" | "pause" | "cancel">;
};

export type CoverageRunResult = {
  snapshot: CoverageSnapshot | null;
  completedUnits: number;
  units: CoverageUnit[];
  status: "completed" | "paused";
};
