export type TrailArtifactManifest = {
  schemaVersion: number;
  buildId?: string;
  region: { id: string };
  artifacts?: Record<string, { rawBytes?: number; sha256?: string }>;
};

export type LocatedTrailArtifact = {
  key: string;
  backend: "packaged-assets" | "private-r2";
  expectedSha256?: string;
};

function validPathPart(value: string) {
  return Boolean(value) && value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function validateArtifactPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      path.split("/").some((part) => !validPathPart(part))) {
    throw new TypeError("Trail manifest artifact paths must be normalized relative paths.");
  }
}

/**
 * Resolve a manifest-declared artifact without listing or inferring bucket keys.
 * V1 remains packaged under the historical Sites ASSETS URL; v2 objects are
 * immutable below the manifest's accepted region and build ID.
 */
export function locateTrailArtifact(
  manifest: TrailArtifactManifest,
  artifactPath: string,
): LocatedTrailArtifact {
  validateArtifactPath(artifactPath);
  if (!validPathPart(manifest.region.id)) throw new TypeError("Invalid trail manifest region id.");

  if (manifest.schemaVersion === 1) {
    return {
      key: `trails/${manifest.region.id}/${artifactPath}`,
      backend: "packaged-assets",
    };
  }
  if (manifest.schemaVersion !== 2) {
    throw new TypeError(`Unsupported trail artifact schema version: ${manifest.schemaVersion}`);
  }
  if (!manifest.buildId || !validPathPart(manifest.buildId)) {
    throw new TypeError("Trail artifact v2 manifest has no valid build ID.");
  }
  const expectedSha256 = manifest.artifacts?.[artifactPath]?.sha256;
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new TypeError(`Trail artifact v2 manifest has no valid SHA-256 for ${artifactPath}.`);
  }
  return {
    key: `trails/${manifest.region.id}/${manifest.buildId}/${artifactPath}`,
    backend: "private-r2",
    expectedSha256,
  };
}
