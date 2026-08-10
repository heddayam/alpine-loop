import { describe, expect, it } from "vitest";
import type { NormalizedTopology } from "../types";
import { conflateOfficialTrails } from "./conflate";
import type { OfficialTrailFeature } from "./types";

function baseTopology(): NormalizedTopology {
  return {
    nodes: [
      { id: "west", externalId: "west", lon: 0, lat: 0, elevationM: null, flags: [], sourceRefs: ["osm"] },
      { id: "east", externalId: "east", lon: 0.01, lat: 0, elevationM: null, flags: [], sourceRefs: ["osm"] },
    ],
    ways: [{
      id: "osm-trail", externalId: "way/1", nodeIds: ["west", "east"], coordinates: [[0, 0], [0.01, 0]],
      name: "Mapped trail", accessState: "public", bidirectional: true, edgeClass: "trail", sourceRefs: ["osm"], flags: [],
    }],
    accessPoints: [],
    portalEvidence: [],
    rejectedWayCount: 0,
  };
}

function official(externalId: string, coordinates: OfficialTrailFeature["coordinates"]): OfficialTrailFeature {
  return {
    externalId,
    name: `Official ${externalId}`,
    trailNumber: null,
    coordinates,
    accessState: "unknown",
    sourceRefs: ["official"],
    flags: ["official-trail-conflation", `official-trail-feature:${externalId}`],
    eligible: true,
    eligibilityReason: null,
  };
}

const policy = { minimumGapLengthM: 100, sampleStepM: 20 };

describe("official trail conflation", () => {
  it("does not duplicate official geometry already represented by OSM", () => {
    const result = conflateOfficialTrails({
      topology: baseTopology(),
      features: [official("same", [[0, 0.00005], [0.01, 0.00005]])],
      sourceId: "official",
      policy,
    });

    expect(result.topology.ways).toHaveLength(1);
    expect(result.audit).toMatchObject({
      eligibleFeatureCount: 1,
      representedFeatureCount: 1,
      acceptedGapCount: 0,
      addedLengthM: 0,
    });
  });

  it("adds a long confirmed gap only when its component attaches to base topology", () => {
    const result = conflateOfficialTrails({
      topology: baseTopology(),
      features: [official("loop-gap", [[0.002, 0], [0.002, 0.004], [0.008, 0.004], [0.008, 0]])],
      sourceId: "official",
      policy,
    });

    expect(result.audit).toMatchObject({
      acceptedGapCount: 1,
      acceptedFeatureCount: 1,
      baseAttachmentCount: 2,
      rejectionCounts: {},
    });
    expect(result.audit.addedLengthM).toBeGreaterThan(1_400);
    const added = result.topology.ways.find(({ sourceRefs }) => sourceRefs.includes("official"));
    expect(added).toMatchObject({
      externalId: "loop-gap",
      name: "Official loop-gap",
      accessState: "unknown",
      bidirectional: true,
      edgeClass: "trail",
      sourceRefs: ["official"],
    });
    expect(added?.flags).toContain("official-trail-feature:loop-gap");
    expect(result.topology.ways[0]?.nodeIds.length).toBeGreaterThan(2);
    expect(result.topology.ways[0]?.nodeIds).toContain(added?.nodeIds[0]);
    expect(result.audit.accepted[0]).toMatchObject({ startAttachment: "base", endAttachment: "base" });
  });

  it("rejects disconnected components and ineligible source records", () => {
    const ineligible = { ...official("snow", [[0.02, 0.02], [0.03, 0.03]]), eligible: false, eligibilityReason: "not-terrestrial" };
    const result = conflateOfficialTrails({
      topology: baseTopology(),
      features: [official("island", [[0.02, 0.02], [0.03, 0.03]]), ineligible],
      sourceId: "official",
      policy,
    });

    expect(result.topology.ways).toHaveLength(1);
    expect(result.audit).toMatchObject({
      inputFeatureCount: 2,
      eligibleFeatureCount: 1,
      ineligibleFeatureCount: 1,
      acceptedGapCount: 0,
      rejectionCounts: {
        "disconnected-official-component": 1,
        "not-terrestrial": 1,
      },
    });
  });

  it("keeps a safely attached gap as a truncated branch instead of inventing an unsafe second join", () => {
    const result = conflateOfficialTrails({
      topology: baseTopology(),
      features: [official("truncated", [[0.002, 0], [0.002, 0.004], [0.008, 0.004], [0.008, 0.0005], [0.009, 0.0005]])],
      sourceId: "official",
      policy,
    });

    expect(result.audit).toMatchObject({ acceptedGapCount: 1, truncatedEndpointCount: 1 });
    expect(result.audit.accepted[0]).toMatchObject({ startAttachment: "base", endAttachment: "truncated" });
    const added = result.topology.ways.find(({ externalId }) => externalId === "truncated");
    expect(added?.flags).toContain("official-trail-truncated-end");
  });

  it("permits a displaced handoff only when the official and base trail bearings align", () => {
    const result = conflateOfficialTrails({
      topology: baseTopology(),
      features: [official("aligned", [[0.002, 0], [0.002, 0.004], [0.008, 0.004], [0.008, 0.00036], [0.009, 0.00036]])],
      sourceId: "official",
      policy: {
        ...policy,
        internalConnectionDistanceM: 50,
        maximumConnectionAngleDegrees: 45,
      },
    });

    expect(result.audit.accepted[0]).toMatchObject({ startAttachment: "base", endAttachment: "base" });
    expect(result.audit.truncatedEndpointCount).toBe(0);
  });

  it("deduplicates overlapping official records deterministically", () => {
    const features = [
      official("a", [[0.002, 0], [0.002, 0.004], [0.008, 0.004], [0.008, 0]]),
      official("b", [[0.002, 0], [0.002, 0.004], [0.008, 0.004], [0.008, 0]]),
    ];
    const first = conflateOfficialTrails({ topology: baseTopology(), features, sourceId: "official", policy });
    const second = conflateOfficialTrails({ topology: baseTopology(), features: [...features].reverse(), sourceId: "official", policy });

    expect(first.audit.acceptedGapCount).toBe(1);
    expect(first.audit.rejectionCounts["duplicate-official-gap"]).toBe(1);
    expect(first.audit).toEqual(second.audit);
    expect(first.topology).toEqual(second.topology);
  });
});
