import { describe, expect, it } from "vitest";
import { reconcileAccess } from "./access";
import { fixtureCompileOptions } from "./fixture-pack";

describe("fixture source adapters", () => {
  it("normalizes OSM-like topology and rejects non-pedestrian ways", async () => {
    const options = await fixtureCompileOptions("/unused");
    await options.topology.adapter.validate(options.topology.snapshot);
    const results = [];
    for await (const result of options.topology.adapter.normalize(options.topology.snapshot)) results.push(result);

    expect(results).toHaveLength(1);
    expect(results[0].rejectedWayCount).toBe(1);
    expect(results[0].ways).toHaveLength(4);
    expect(results[0].ways.find(({ id }) => id === "w-oneway")?.bidirectional).toBe(false);
    expect(results[0].ways.find(({ id }) => id === "w-ridge")?.accessState).toBe("private");
    expect(results[0].accessPoints.map(({ externalId }) => externalId).sort()).toEqual(["n-a", "n-g"]);
  });

  it("normalizes official access evidence with provenance", async () => {
    const options = await fixtureCompileOptions("/unused");
    await options.officialAccess.adapter.validate(options.officialAccess.snapshot);
    const records = await options.officialAccess.adapter.normalize(options.officialAccess.snapshot);

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
    await expect(options.topology.adapter.validate(snapshot)).rejects.toThrow("Content hash mismatch");
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
