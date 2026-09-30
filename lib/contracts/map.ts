import { z } from "zod";
import { areaGeometrySchema, bboxSchema } from "./routes";

/** Exact start predicates shared with Full search; outlines are separate UI data. */
export const mapStartFilterSchema = z.object({
  includeUncertainAccess: z.boolean(),
  predicates: z.array(areaGeometrySchema).max(2),
  namedRegionIds: z.array(z.string().min(1)).max(100).optional(),
}).strict();
export type MapStartFilter = z.infer<typeof mapStartFilterSchema>;

export const mapRequestSchema = z.object({
  bbox: bboxSchema,
  trails: z.boolean().default(true),
  // null represents an unresolved area and deliberately has no eligible starts.
  startFilter: mapStartFilterSchema.nullable().optional(),
}).strict();
