import { z } from "zod";
import { isoDateSchema } from "./common";
import { packSourceSchema } from "./manifest";
import { areaGeometrySchema, MAX_ROUTE_DISTANCE_MILES, PREPARATION_BUFFER_MILES } from "./routes";

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const releaseArtifactSchema = z.object({
  id: digest,
  path: z.string().regex(/^objects\/[a-f0-9]{64}\.sqlite\.gz$/),
  compressedBytes: bytes,
  bytes,
  geometry: areaGeometrySchema,
  /** Starts eligible for this independent buffered graph. */
  startGeometry: areaGeometrySchema.optional(),
  /** Immutable network graph identity, independent of the catalog release. */
  graphId: identity.optional(),
  /** Stable named region ownership, independent of artifact content hashes. */
  regionId: identity.optional(),
  /** Absent on retained artifacts compiled under the earlier admission rules. */
  accessPolicyVersion: z.string().min(1).optional(),
}).strict().refine((artifact) => artifact.path === `objects/${artifact.id}.sqlite.gz`, "Artifact path must match its SHA-256 identity");

export const releaseSectionSchema = z.object({
  id: identity,
  name: z.string().min(1).optional(),
  geometry: areaGeometrySchema,
  artifactIds: z.array(digest).min(1),
  /** Retired area IDs whose coverage is preserved by this independent graph. */
  replaces: z.array(identity).min(1).optional(),
  area: z.object({
    maximumRouteMiles: z.literal(MAX_ROUTE_DISTANCE_MILES),
    bufferMiles: z.literal(PREPARATION_BUFFER_MILES),
  }).strict().optional(),
  network: z.object({
    /** Eligible source topology, before compiler portal splitting. */
    nodeCount: bytes,
    physicalEdgeCount: bytes,
    loopBlockCount: bytes.optional(),
    sourceBoundaryLimited: z.boolean(),
  }).strict().optional(),
}).strict();

export const dataReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  graphSchemaVersion: z.literal("7"),
  partitioning: z.enum(["geographic", "connected-networks", "local-areas"]).optional(),
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
    if (section.replaces && (release.partitioning !== "local-areas" ||
      new Set(section.replaces).size !== section.replaces.length ||
      section.replaces.some(id => release.sections.some(active => active.id === id)))) {
      context.addIssue({ code: "custom", message: `Area ${section.id} has invalid replacement identities` });
    }
    if (new Set(section.artifactIds).size !== section.artifactIds.length || section.artifactIds.some((id) => !artifacts.has(id))) {
      context.addIssue({ code: "custom", message: `Section ${section.id} has invalid artifact references` });
    }
    if (release.partitioning === "connected-networks" && (!section.network || section.artifactIds.some(id => !release.artifacts.find(artifact => artifact.id === id)?.graphId))) {
      context.addIssue({ code: "custom", message: `Network ${section.id} requires network metadata and immutable graph identities` });
    }
    if (release.partitioning === "local-areas") {
      const artifact = release.artifacts.find(item => item.id === section.artifactIds[0]);
      if (!section.area || section.artifactIds.length !== 1 || !artifact?.graphId || !artifact.startGeometry || JSON.stringify(section.geometry) !== JSON.stringify(artifact.startGeometry)) {
        context.addIssue({ code: "custom", message: `Area ${section.id} requires one independent graph and matching start geometry` });
      }
      if (artifact?.regionId !== undefined && artifact.regionId !== section.id) {
        context.addIssue({ code: "custom", message: `Region ${section.id} has inconsistent graph ownership` });
      }
    }
  }
  const retired = release.sections.flatMap(section => section.replaces ?? []);
  if (new Set(retired).size !== retired.length) {
    context.addIssue({ code: "custom", message: "A retired area must have one replacement" });
  }
  if (release.partitioning === "connected-networks" || release.partitioning === "local-areas") {
    const references = release.sections.flatMap(section => section.artifactIds);
    if (new Set(references).size !== references.length || artifacts.size !== references.length) {
      context.addIssue({ code: "custom", message: "Every independent graph artifact must belong to exactly one section" });
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
