import { z } from "zod";
import { isoDateSchema } from "./common";
import { closedRouteTopologyV3Schema, searchEffortV3Schema } from "./routes";

export const closedRouteBenchmarkEngineSchema = z.enum([
  "gate4-separated-lanes",
  "gate4-unified-lane",
  "gate5-topology",
  "gate5-oracle",
]);

export const closedRouteBenchmarkCaseResultSchema = z.object({
  caseId: z.string().min(1),
  startAccessPointId: z.string().min(1).optional(),
  oracleFeasible: z.boolean().optional(),
  exactCount: z.number().int().nonnegative(),
  diverseExactCount: z.number().int().nonnegative(),
  elapsedMs: z.number().finite().nonnegative(),
  timeToFirstExactMs: z.number().finite().nonnegative().optional(),
  expandedStates: z.number().int().nonnegative(),
  directedValidationRejectionCount: z.number().int().nonnegative(),
  attachmentGroupCount: z.number().int().nonnegative(),
  probedAttachmentGroupCount: z.number().int().nonnegative(),
  topologyKinds: z.array(closedRouteTopologyV3Schema.shape.kind),
  routeIds: z.array(z.string().min(1)),
  truncationReasons: z.array(z.string()),
}).strict();

export const closedRouteBenchmarkOutputSchema = z.object({
  formatVersion: z.literal(1),
  generatedAt: isoDateSchema,
  engine: closedRouteBenchmarkEngineSchema,
  effort: searchEffortV3Schema.or(z.literal("oracle-60s")),
  deadlineMs: z.number().int().positive(),
  pack: z.object({
    id: z.string().min(1),
    schemaVersion: z.string().min(1),
    dataVersion: z.string().min(1),
  }).strict(),
  cases: z.array(closedRouteBenchmarkCaseResultSchema).min(1),
}).strict();

export type ClosedRouteBenchmarkOutput = z.infer<typeof closedRouteBenchmarkOutputSchema>;
