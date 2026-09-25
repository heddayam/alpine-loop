import { z } from "zod";
import { isoDateSchema } from "./common";
import { packSourceSchema } from "./manifest";
import { areaGeometrySchema } from "./routes";

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const releaseArtifactSchema = z.object({
  id: digest,
  path: z.string().regex(/^objects\/[a-f0-9]{64}\.sqlite\.gz$/),
  compressedBytes: bytes,
  bytes,
  geometry: areaGeometrySchema,
}).strict().refine((artifact) => artifact.path === `objects/${artifact.id}.sqlite.gz`, "Artifact path must match its SHA-256 identity");

export const releaseSectionSchema = z.object({
  id: identity,
  geometry: areaGeometrySchema,
  artifactIds: z.array(digest).min(1),
}).strict();

export const dataReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  graphSchemaVersion: z.literal("7"),
  id: identity,
  builtAt: isoDateSchema,
  compilerVersion: z.string().min(1),
  metricAlgorithmVersion: z.string().min(1),
  sources: z.array(packSourceSchema).min(1),
  geometry: areaGeometrySchema,
  sections: z.array(releaseSectionSchema).min(1),
  artifacts: z.array(releaseArtifactSchema).min(1),
  regions: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), geometry: areaGeometrySchema,
    aliases: z.array(z.string()), sourceIds: z.array(z.string()),
  }).strict()),
  limitations: z.array(z.string()),
}).strict().superRefine((release, context) => {
  const artifacts = new Set(release.artifacts.map(({ id }) => id));
  if (artifacts.size !== release.artifacts.length || new Set(release.sections.map(({ id }) => id)).size !== release.sections.length) {
    context.addIssue({ code: "custom", message: "Release artifact and section identities must be unique" });
  }
  for (const section of release.sections) {
    if (new Set(section.artifactIds).size !== section.artifactIds.length || section.artifactIds.some((id) => !artifacts.has(id))) {
      context.addIssue({ code: "custom", message: `Section ${section.id} has invalid artifact references` });
    }
  }
});

export const coverageInstallationSchema = z.object({
  id: identity, releaseId: identity, createdAt: isoDateSchema,
  sectionIds: z.array(identity), artifactIds: z.array(digest), geometry: areaGeometrySchema,
}).strict();

export const downloadRequestSchema = z.object({
  releaseId: identity, sectionIds: z.array(identity).min(1),
}).strict();

export const downloadPlanSchema = downloadRequestSchema.extend({
  artifactIds: z.array(digest), geometry: areaGeometrySchema,
  downloadBytes: bytes, installedBytes: bytes, additionalBytes: bytes, reusableBytes: bytes,
});

export const downloadJobSchema = z.object({
  id: identity, releaseId: identity, sectionIds: z.array(identity),
  status: z.enum(["queued", "running", "pausing", "paused", "cancelled", "failed", "completed"]),
  stage: z.string(), downloadedBytes: bytes, totalBytes: bytes,
  createdAt: isoDateSchema, updatedAt: isoDateSchema, error: z.string().nullable(),
  installation: coverageInstallationSchema.nullable(),
}).strict();

export const downloadCatalogSchema = z.object({
  release: dataReleaseSchema.nullable(), installed: coverageInstallationSchema.nullable(),
  jobs: z.array(downloadJobSchema), error: z.string().nullable(),
}).strict();
export const downloadActionSchema = z.enum(["pause", "resume", "cancel"]);

export type DataRelease = z.infer<typeof dataReleaseSchema>;
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type ReleaseSection = z.infer<typeof releaseSectionSchema>;
export type CoverageInstallation = z.infer<typeof coverageInstallationSchema>;
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;
export type DownloadPlan = z.infer<typeof downloadPlanSchema>;
export type DownloadJob = z.infer<typeof downloadJobSchema>;
export type DownloadCatalog = z.infer<typeof downloadCatalogSchema>;
