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

export const packManifestSchema = z.object({
  schemaVersion: z.literal("6"),
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
    closedRouteTopology: z.literal(true),
    batchSearchRegions: z.literal(true),
    elevationProfiles: z.literal(true),
    portalAccessPoints: z.literal(true),
  }).catchall(z.boolean()),
  closedRouteTopology: z.object({
    runtimeMode: z.literal("reachable-graph-fallback"),
    algorithmVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    profiles: z.tuple([z.literal("known"), z.literal("inclusive")]),
  }).strict(),
  fieldConfidence: z.record(z.string(), confidenceSchema),
  sources: z.array(packSourceSchema).min(1),
}).strict();

export const topologyProfileSchema = z.enum(["known", "inclusive"]);
export type TopologyProfile = z.infer<typeof topologyProfileSchema>;
export type PackManifest = z.infer<typeof packManifestSchema>;
export const packManifestV6Schema = packManifestSchema;
export type PackManifestV6 = PackManifest;
