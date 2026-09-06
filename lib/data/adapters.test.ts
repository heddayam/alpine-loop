import { describe, expect, it } from "vitest";
import { reconcileAccess } from "./access";
import { fixtureCompileOptions } from "./fixture-pack";
import { FixtureTopologyAdapter } from "./fixture-topology-adapter";

describe("fixture source adapters", () => {
  it("normalizes OSM-like topology and rejects non-pedestrian ways", async () => {
    const options = await fixtureCompileOptions("/unused");
    const topology = options.topology.data;
    expect(topology.rejectedWayCount).toBe(1);
    expect(topology.ways).toHaveLength(4);
    expect(topology.ways.find(({ id }) => id === "w-oneway")?.bidirectional).toBe(false);
    expect(topology.ways.find(({ id }) => id === "w-ridge")?.accessState).toBe("private");
    expect(topology.accessPoints.map(({ externalId }) => externalId).sort()).toEqual(["n-a", "n-g"]);
  });

  it("normalizes official access evidence with provenance", async () => {
    const options = await fixtureCompileOptions("/unused");
    const officialAccess = options.officialAccess!;
    await officialAccess.adapter.validate(officialAccess.snapshot);
    const records = await officialAccess.adapter.normalize(officialAccess.snapshot);

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: "w-ridge",
        accessState: "public",
        confidence: "high",
        sourceId: "fixture-official-access",
      }),
    ]));
  });

  it("fails validation when a pinned source hash changes", async () => {
    const options = await fixtureCompileOptions("/unused");
    const snapshot = { ...options.topology.snapshot, contentHash: `sha256:${"0".repeat(64)}` as const };
    await expect(new FixtureTopologyAdapter().validate(snapshot)).rejects.toThrow("Content hash mismatch");
  });
});

describe("access reconciliation", () => {
  it("applies official restriction, official permission, OSM, then unknown precedence", () => {
    expect(reconcileAccess("public", ["closed"]).state).toBe("closed");
    expect(reconcileAccess("private", ["public"]).state).toBe("public");
    expect(reconcileAccess("private", []).state).toBe("private");
    expect(reconcileAccess("unknown", []).state).toBe("unknown");
  });

  it("never resolves conflicting official evidence permissively", () => {
    expect(reconcileAccess("public", ["public", "closed"])).toEqual({
      state: "unknown",
      conflict: true,
      source: "none",
    });
  });
});
