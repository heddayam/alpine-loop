import { z } from "zod";
import { isoDateSchema } from "./common";
import { originSchema } from "./discovery";
import {
  areaGeometrySchema, bboxSchema, constraintViolationV3Schema, driveTimeDurationSchema,
  generatedClosedRouteV3Schema, routeCriteriaSchema,
} from "./routes";
import { routeJobProgressSchema, routeJobStatusSchema } from "./route-jobs";

const regionIdsSchema = z.array(z.string().trim().min(1)).max(100);

export const searchAreaSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("drawn-area"), bbox: bboxSchema }).strict(),
  z.object({ mode: z.literal("named-regions"), regionIds: regionIdsSchema.min(1) }).strict(),
  z.object({
    mode: z.literal("drive-time"), origin: originSchema, durationMinutes: driveTimeDurationSchema,
    regionIds: regionIdsSchema,
  }).strict(),
]);

export const searchIntentSchema = z.object({ area: searchAreaSchema, criteria: routeCriteriaSchema }).strict();
export const searchRequestSchema = searchIntentSchema.extend({ limit: z.number().int().min(1).max(20).default(10) });

export const searchAreaSnapshotSchema = z.object({
  label: z.string().min(1),
  filterGeometry: areaGeometrySchema.optional(),
  refinementGeometry: areaGeometrySchema.optional(),
}).strict();

export const searchRouteSchema = generatedClosedRouteV3Schema.extend({ regionLabel: z.string() });
export const closeSearchRouteSchema = searchRouteSchema.extend({ violations: z.array(constraintViolationV3Schema).min(1) });
export const searchResultSchema = z.object({
  request: searchRequestSchema,
  area: searchAreaSnapshotSchema,
  exact: z.array(searchRouteSchema).max(20),
  nearMisses: z.array(closeSearchRouteSchema).max(20),
  incomplete: z.boolean(),
  messages: z.array(z.string()),
}).strict();

export const searchCatalogSchema = z.object({
  regions: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
  coverages: z.array(areaGeometrySchema),
  display: z.object({ center: z.tuple([z.number().finite(), z.number().finite()]), zoom: z.number().finite() }).strict(),
}).strict();

export const routeJobV2Schema = z.object({
  version: z.literal(2), id: z.string().uuid(), status: routeJobStatusSchema,
  request: searchIntentSchema,
  area: searchAreaSnapshotSchema,
  progress: routeJobProgressSchema,
  partial: z.boolean(), stale: z.boolean(),
  createdAt: isoDateSchema, updatedAt: isoDateSchema, completedAt: isoDateSchema.optional(),
  error: z.string().min(1).optional(),
}).strict();
export const routeJobResultV2Schema = z.discriminatedUnion("matchType", [
  z.object({ matchType: z.literal("exact"), accessPointId: z.string().min(1), route: searchRouteSchema }).strict(),
  z.object({ matchType: z.literal("near-miss"), accessPointId: z.string().min(1), route: closeSearchRouteSchema }).strict(),
]);
export const routeJobResultsPageV2Schema = z.object({
  version: z.literal(2), job: routeJobV2Schema, results: z.array(routeJobResultV2Schema).max(50),
  nextCursor: z.string().min(1).optional(),
}).strict();
export const routeJobListV2Schema = z.object({ version: z.literal(2), jobs: z.array(routeJobV2Schema) }).strict();

export type SearchArea = z.infer<typeof searchAreaSchema>;
export type SearchIntent = z.infer<typeof searchIntentSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchAreaSnapshot = z.infer<typeof searchAreaSnapshotSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchCatalog = z.infer<typeof searchCatalogSchema>;
export type SearchRoute = z.infer<typeof searchRouteSchema>;
export type CloseSearchRoute = z.infer<typeof closeSearchRouteSchema>;
export type RouteJobV2 = z.infer<typeof routeJobV2Schema>;
export type RouteJobResultV2 = z.infer<typeof routeJobResultV2Schema>;
export type RouteJobResultsPageV2 = z.infer<typeof routeJobResultsPageV2Schema>;
