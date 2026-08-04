import { z } from "zod";
import { bboxSchema } from "./routes";
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

export type PackManifestV1 = z.infer<typeof packManifestV1Schema>;
