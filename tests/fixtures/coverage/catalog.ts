import type { DataRelease, DownloadCatalog, DownloadJob, DownloadPlan } from "../../../lib/contracts/releases";
export const geometry: DataRelease["geometry"] = { type: "Polygon", coordinates: [[[-122,47],[-121.75,47],[-121.75,47.25],[-122,47.25],[-122,47]]] };
const artifactId = "a".repeat(64);
export const release: DataRelease = {
  schemaVersion: 1, graphSchemaVersion: "7", id: "fixture", builtAt: "2026-09-24T00:00:00Z",
  compilerVersion: "fixture", metricAlgorithmVersion: "fixture", geometry,
  artifacts: [{ id: artifactId, path: `objects/${artifactId}.sqlite.gz`, bytes: 1048576, compressedBytes: 262144, geometry }],
  sections: [{ id: "section", geometry, artifactIds: [artifactId] }],
  sources: [{ id: "osm", authority: "OpenStreetMap contributors", dataset: "OSM", version: "fixture", retrievedAt: "2026-09-24T00:00:00Z", url: "https://www.openstreetmap.org", license: "ODbL", contentHash: `sha256:${artifactId}` }],
  regions: [], limitations: ["Source data can omit trails."],
};
export const request = { releaseId: release.id, sectionIds: ["section"] };
export const plan: DownloadPlan = { ...request, artifactIds: [artifactId], geometry, downloadBytes: 262144, installedBytes: 1048576, additionalBytes: 1310720, reusableBytes: 0 };
export const catalog: DownloadCatalog = { release, installed: null, jobs: [], error: null };
export const job: DownloadJob = { id: "job", ...request, status: "running", stage: "Downloading", downloadedBytes: 1024, totalBytes: plan.downloadBytes, createdAt: release.builtAt, updatedAt: release.builtAt, error: null, installation: null };
export const installation = { id: "installed", releaseId: release.id, createdAt: release.builtAt, sectionIds: request.sectionIds, artifactIds: plan.artifactIds, geometry };
