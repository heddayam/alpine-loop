import { z } from "zod";
import { areaGeometrySchema, bboxSchema } from "./routes";
import { confidenceSchema, isoDateSchema } from "./common";

export const packSourceSchema = z.object({
  id: z.string().min(1),
  authority: z.string().min(1),
  dataset: z.string().min(1),
  version: z.string().min(1),
  retrievedAt: isoDateSchema,
  url: z.string().url(),
  license: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export const packManifestV1Schema = z.object({
  schemaVersion: z.literal("1"),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  dataVersion: z.string().min(1),
  builtAt: isoDateSchema,
  compilerVersion: z.string().min(1),
  metricAlgorithmVersion: z.string().min(1),
  coverage: z.object({
    bbox: bboxSchema,
    boundary: z.object({
      type: z.literal("Polygon"),
      coordinates: z.array(z.array(z.tuple([z.number().finite(), z.number().finite()])).min(4)).min(1),
    }).strict(),
  }).strict(),
  display: z.object({ center: z.tuple([z.number().finite(), z.number().finite()]), zoom: z.number().finite() }).strict(),
  capabilities: z.object({ elevation: z.boolean(), officialAccess: z.boolean() }).catchall(z.boolean()),
  fieldConfidence: z.record(z.string(), confidenceSchema),
  sources: z.array(packSourceSchema).min(1),
}).strict();

export const packManifestV2Schema = z.object({
  schemaVersion: z.literal("2"),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  dataVersion: z.string().min(1),
  builtAt: isoDateSchema,
  compilerVersion: z.string().min(1),
  metricAlgorithmVersion: z.string().min(1),
  coverage: z.object({
    bbox: bboxSchema,
    boundary: areaGeometrySchema,
  }).strict(),
  display: z.object({ center: z.tuple([z.number().finite(), z.number().finite()]), zoom: z.number().finite() }).strict(),
  capabilities: z.object({
    elevation: z.boolean(),
    officialAccess: z.boolean(),
    namedAreas: z.literal(true),
  }).catchall(z.boolean()),
  fieldConfidence: z.record(z.string(), confidenceSchema),
  sources: z.array(packSourceSchema).min(1),
}).strict();

export const topologyProfileSchema = z.enum(["known", "inclusive"]);

export const packManifestV3Schema = packManifestV2Schema.extend({
  schemaVersion: z.literal("3"),
  capabilities: z.object({
    elevation: z.boolean(),
    officialAccess: z.boolean(),
    namedAreas: z.literal(true),
    closedRouteTopology: z.literal(true),
  }).catchall(z.boolean()),
  closedRouteTopology: z.object({
    runtimeMode: z.enum(["primitive", "reachable-graph-fallback"]),
    algorithmVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    profiles: z.tuple([z.literal("known"), z.literal("inclusive")]),
  }).strict(),
}).strict();

export const packManifestV4Schema = packManifestV3Schema.extend({
  schemaVersion: z.literal("4"),
  capabilities: z.object({
    elevation: z.boolean(),
    officialAccess: z.boolean(),
    namedAreas: z.literal(true),
    closedRouteTopology: z.literal(true),
    batchSearchRegions: z.literal(true),
  }).catchall(z.boolean()),
}).strict();

export const packManifestSchema = z.discriminatedUnion("schemaVersion", [
  packManifestV1Schema,
  packManifestV2Schema,
  packManifestV3Schema,
  packManifestV4Schema,
]);

export type PackManifestV1 = z.infer<typeof packManifestV1Schema>;
export type PackManifestV2 = z.infer<typeof packManifestV2Schema>;
export type TopologyProfile = z.infer<typeof topologyProfileSchema>;
export type PackManifestV3 = z.infer<typeof packManifestV3Schema>;
export type PackManifestV4 = z.infer<typeof packManifestV4Schema>;
export type PackManifest = z.infer<typeof packManifestSchema>;
