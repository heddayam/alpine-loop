import { describe, expect, it } from "vitest";
import { packManifestV1Schema, packManifestV2Schema, packManifestV3Schema, packManifestV4Schema, packManifestV5Schema } from "./manifest";

const manifest = {
  schemaVersion: "1",
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
  capabilities: { elevation: true, officialAccess: true },
  fieldConfidence: { elevation: "high" },
  sources: [{
    id: "fixture-source", authority: "Alpine Search", dataset: "Synthetic fixture", version: "1",
    retrievedAt: "2026-08-04T00:00:00Z", url: "https://example.invalid/fixture", license: "CC0-1.0",
    contentHash: `sha256:${"0".repeat(64)}`,
  }],
};

describe("PackManifestV1", () => {
  it("accepts a complete versioned manifest", () => {
    expect(packManifestV1Schema.parse(manifest).id).toBe("fixture-pack");
  });

  it("rejects a missing source license decision", () => {
    const source = { ...manifest.sources[0], license: "" };
    expect(packManifestV1Schema.safeParse({ ...manifest, sources: [source] }).success).toBe(false);
  });
});

describe("PackManifestV2", () => {
  it("requires the named-area capability", () => {
    const v2 = {
      ...manifest,
      schemaVersion: "2",
      capabilities: { ...manifest.capabilities, namedAreas: true },
    };
    expect(packManifestV2Schema.parse(v2).capabilities.namedAreas).toBe(true);
    expect(packManifestV2Schema.safeParse({
      ...v2,
      capabilities: manifest.capabilities,
    }).success).toBe(false);
  });
});

describe("PackManifestV3", () => {
  const v3 = {
    ...manifest,
    schemaVersion: "3",
    capabilities: {
      ...manifest.capabilities,
      namedAreas: true,
      closedRouteTopology: true,
    },
    closedRouteTopology: {
      runtimeMode: "primitive",
      algorithmVersion: "closed-topology-v1",
      policyVersion: "closed-primitives-v1",
      profiles: ["known", "inclusive"],
    },
  };

  it("requires both deterministic topology profiles", () => {
    expect(packManifestV3Schema.parse(v3).closedRouteTopology.profiles).toEqual(["known", "inclusive"]);
    expect(packManifestV3Schema.safeParse({
      ...v3,
      closedRouteTopology: { ...v3.closedRouteTopology, profiles: ["inclusive", "known"] },
    }).success).toBe(false);
  });

  it("requires the closed-route topology capability", () => {
    expect(packManifestV3Schema.safeParse({
      ...v3,
      capabilities: { ...v3.capabilities, closedRouteTopology: false },
    }).success).toBe(false);
  });
});

describe("PackManifestV4", () => {
  it("requires the reviewed batch-search-region capability", () => {
    const v4 = {
      ...manifest,
      schemaVersion: "4",
      capabilities: {
        ...manifest.capabilities,
        namedAreas: true,
        closedRouteTopology: true,
        batchSearchRegions: true,
      },
      closedRouteTopology: {
        runtimeMode: "reachable-graph-fallback",
        algorithmVersion: "closed-topology-v1",
        policyVersion: "closed-primitives-v1",
        profiles: ["known", "inclusive"],
      },
    };
    expect(packManifestV4Schema.parse(v4).capabilities.batchSearchRegions).toBe(true);
    expect(packManifestV4Schema.safeParse({
      ...v4,
      capabilities: { ...v4.capabilities, batchSearchRegions: false },
    }).success).toBe(false);
  });
});

describe("PackManifestV5", () => {
  it("requires persisted elevation profiles", () => {
    const v5 = {
      ...manifest,
      schemaVersion: "5",
      capabilities: {
        ...manifest.capabilities,
        namedAreas: true,
        closedRouteTopology: true,
        batchSearchRegions: true,
        elevationProfiles: true,
      },
      closedRouteTopology: {
        runtimeMode: "reachable-graph-fallback",
        algorithmVersion: "closed-topology-v1",
        policyVersion: "closed-primitives-v1",
        profiles: ["known", "inclusive"],
      },
    };
    expect(packManifestV5Schema.parse(v5).capabilities.elevationProfiles).toBe(true);
    expect(packManifestV5Schema.safeParse({
      ...v5,
      capabilities: { ...v5.capabilities, elevationProfiles: false },
    }).success).toBe(false);
  });
});
