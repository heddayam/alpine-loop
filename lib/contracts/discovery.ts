import { z } from "zod";
import {
  areaGeometrySchema,
  bboxSchema,
} from "./routes";

export const namedAreaKindSchema = z.enum([
  "pack",
  "county",
  "city",
  "park",
  "preserve",
  "protected-area",
]);

export const namedAreaSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: namedAreaKindSchema,
  context: z.string().min(1).optional(),
  bbox: bboxSchema,
  sourceIds: z.array(z.string().min(1)).min(1),
}).strict();

export const namedAreaSchema = namedAreaSummarySchema.extend({
  geometry: areaGeometrySchema,
}).strict();

export const searchRegionSummarySchema = namedAreaSummarySchema.extend({
  displayOrder: z.number().int().nonnegative(),
}).strict();

export const geocodingSuggestRequestSchema = z.object({
  text: z.string().trim().min(2).max(200),
}).strict();

export const geocodingSuggestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  magicKey: z.string().min(1),
}).strict();

export const geocodingResolveRequestSchema = z.object({
  text: z.string().trim().min(2).max(200),
  magicKey: z.string().min(1),
}).strict();

export const originSchema = z.object({
  lon: z.number().finite().min(-180).max(180),
  lat: z.number().finite().min(-90).max(90),
  label: z.string().trim().min(1).max(240),
}).strict();

export type NamedAreaSummary = z.infer<typeof namedAreaSummarySchema>;
export type NamedArea = z.infer<typeof namedAreaSchema>;
export type SearchRegionSummary = z.infer<typeof searchRegionSummarySchema>;
export type Origin = z.infer<typeof originSchema>;
