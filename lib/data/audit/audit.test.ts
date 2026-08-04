import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPackAuditPassed, auditRegionalPack } from "./audit";
import { attachOfficialEvidence, type OfficialAccessJoinFeature } from "../authorities";
import { auditOfficialAccessJoins } from "./access-joins";
import type { RegionalPackAuditInput } from "./types";

async function fixture(): Promise<RegionalPackAuditInput> {
  return JSON.parse(await readFile(path.resolve("data/fixtures/source/audit/pack-input.json"), "utf8")) as RegionalPackAuditInput;
}

describe("regional pack audit", () => {
  it("reports connectivity, access, rejections, elevation gaps, and complete attribution", async () => {
    const audit = auditRegionalPack(await fixture());
    expect(audit.counts).toEqual({ nodes: 3, directedEdges: 3, accessPoints: 1, sources: 2, rejectedEdges: 2, conflicts: 0 });
    expect(audit.accessStateCounts).toEqual({ public: 2, unknown: 1, private: 0, closed: 0, prohibited: 0 });
    expect(audit.topology).toEqual({ componentCount: 1, isolatedNodeCount: 0, largestComponentNodeCount: 3, largestComponentFraction: 1 });
    expect(audit.elevation).toEqual({ missingNodeCount: 1, missingEdgeCount: 1 });
    expect(audit.unattributedRecordIds).toEqual([]);
    expect(audit.unknownSourceReferenceRecordIds).toEqual([]);
    expect(audit.errors).toEqual([]);
    expect(audit.warnings).toEqual(expect.arrayContaining([
      "Elevation is missing for 1 nodes and 1 edges",
      "2 source edges were rejected",
    ]));
    expect(() => assertPackAuditPassed(audit)).not.toThrow();
  });

  it("makes conflicts, implausible metrics, isolated nodes, missing attribution, and license gaps fatal", async () => {
    const input = await fixture();
    input.edges[0].lengthM = -1;
    input.edges[1].sourceRefs = [];
    input.nodes.push({ id: "isolated", elevationM: 50, sourceRefs: ["missing-source"] });
    input.sources[1].termsDecision = "";
    input.sources[1].contentHash = "not-a-hash";
    input.conflictRecordIds = ["edge:ab", "edge:ab"];
    const audit = auditRegionalPack(input);
    expect(audit.implausibleMetricRecordIds).toEqual(["ab"]);
    expect(audit.unattributedRecordIds).toEqual(["edge:ba"]);
    expect(audit.unknownSourceReferenceRecordIds).toEqual(["node:isolated"]);
    expect(audit.counts.conflicts).toBe(1);
    expect(audit.topology).toMatchObject({ componentCount: 2, isolatedNodeCount: 1 });
    expect(audit.errors).toEqual(expect.arrayContaining([
      "Source official has no license/terms decision",
      "Source official has no valid content hash",
      "1 records have no source attribution",
      "1 records reference unknown sources",
      "Graph has 1 isolated nodes",
      "1 edges have implausible metrics",
      "1 access conflicts require review",
    ]));
    expect(() => assertPackAuditPassed(audit)).toThrow(/Pack audit failed/);
  });

  it("counts every access state separately", async () => {
    const input = await fixture();
    input.edges = ["public", "unknown", "private", "closed", "prohibited"].map((accessState, index) => ({
      ...input.edges[0], id: `edge-${index}`, accessState,
    })) as RegionalPackAuditInput["edges"];
    expect(auditRegionalPack(input).accessStateCounts).toEqual({ public: 1, unknown: 1, private: 1, closed: 1, prohibited: 1 });
  });
});

describe("official access join audit", () => {
  const feature: OfficialAccessJoinFeature = {
    sourceId: "official",
    authorityFeatureId: "agency-7",
    geometry: { type: "LineString", coordinates: [[-122, 37], [-121.99, 37.01]] },
    evidence: {
      sourceId: "official", externalId: "agency-7", lon: -121.99, lat: 37.01,
      name: "Agency Trail", accessState: "closed", confidence: "high",
    },
  };

  it("retains authority IDs while validating compiler-target evidence", () => {
    const join = attachOfficialEvidence(feature, "osm-10", { matchMethod: "nearest-within-tolerance", distanceM: 1.5 });
    expect(auditOfficialAccessJoins([feature], [join], new Set(["osm-10"]))).toEqual({
      authorityFeatureCount: 1,
      appliedJoinCount: 1,
      unmatchedAuthorityFeatureIds: [],
      errors: [],
      warnings: [],
    });
  });

  it("reports unmatched, unknown-target, and identity-corrupting joins", () => {
    const join = attachOfficialEvidence(feature, "missing-osm", { matchMethod: "spatial-intersection", distanceM: 0 });
    join.evidence.externalId = "overwritten";
    const audit = auditOfficialAccessJoins([feature], [join], new Set());
    expect(audit.errors).toEqual([
      "Join official:agency-7 references unknown topology feature missing-osm",
      "Join official:agency-7 evidence does not preserve its source/target identity",
    ]);
  });
});
