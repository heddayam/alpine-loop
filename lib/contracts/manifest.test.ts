import { describe, expect, it } from "vitest";
import { packManifestSchema } from "./manifest";

const manifest = {
  schemaVersion: "6",
  id: "fixture-pack",
  name: "Fixture Pack",
  dataVersion: "fixture-v1",
  builtAt: "2026-08-04T00:00:00Z",
  compilerVersion: "1",
  metricAlgorithmVersion: "1",
  coverage: {
    bbox: [-122.2, 37.1, -122.1, 37.2],
    boundary: { type: "Polygon", coordinates: [[[-122.2, 37.1], [-122.1, 37.1], [-122.1, 37.2], [-122.2, 37.1]]] },
  },
  display: { center: [-122.15, 37.15], zoom: 12 },
  capabilities: { elevation: true, officialAccess: true, namedAreas: true, closedRouteTopology: true, batchSearchRegions: true, elevationProfiles: true, portalAccessPoints: true },
  closedRouteTopology: { runtimeMode: "reachable-graph-fallback", algorithmVersion: "topology-v1", policyVersion: "decision-v1", profiles: ["known", "inclusive"] },
  fieldConfidence: { elevation: "high" },
  sources: [{
    id: "fixture-source", authority: "Alpine Loop", dataset: "Synthetic fixture", version: "1",
    retrievedAt: "2026-08-04T00:00:00Z", url: "https://example.invalid/fixture", license: "CC0-1.0",
    contentHash: `sha256:${"0".repeat(64)}`,
  }],
};

describe("current graph manifest", () => {
  it("requires current data capabilities and both deterministic profiles", () => {
    expect(packManifestSchema.parse(manifest).id).toBe("fixture-pack");
    for (const capability of ["namedAreas", "closedRouteTopology", "batchSearchRegions", "elevationProfiles", "portalAccessPoints"]) {
      expect(packManifestSchema.safeParse({ ...manifest, capabilities: { ...manifest.capabilities, [capability]: false } }).success).toBe(false);
    }
    expect(packManifestSchema.safeParse({ ...manifest, closedRouteTopology: { ...manifest.closedRouteTopology, profiles: ["inclusive", "known"] } }).success).toBe(false);
  });
  it("rejects unsupported representations and unattributed sources", () => {
    for (const schemaVersion of ["1", "2", "3", "4", "5"]) expect(packManifestSchema.safeParse({ ...manifest, schemaVersion }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...manifest, closedRouteTopology: { ...manifest.closedRouteTopology, runtimeMode: "primitive" } }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...manifest, sources: [{ ...manifest.sources[0], license: "" }] }).success).toBe(false);
  });
});
