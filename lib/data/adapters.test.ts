import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "./file-source";
import { reconcileAccess } from "./access";
import { fixtureCompileOptions } from "./fixture-pack";
import { prepareFixtureTopology } from "./fixture-topology-adapter";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

  it.each(["duplicate node", "missing pedestrian node", "missing rejected-way node"])(
    "rejects %s during fixture preparation",
    async (malformation) => {
      const options = await fixtureCompileOptions("/unused");
      const original = options.topology.snapshot;
      const input = JSON.parse(await readFile(original.localPath, "utf8"));
      if (malformation === "duplicate node") input.nodes.push(input.nodes[0]);
      else input.ways.push({
        id: "broken-way",
        nodeIds: [input.nodes[0].id, "missing-node"],
        tags: { highway: malformation === "missing pedestrian node" ? "path" : "motorway" },
      });
      const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-topology-fixture-"));
      temporaryDirectories.push(directory);
      const localPath = path.join(directory, "topology.json");
      await writeFile(localPath, JSON.stringify(input));
      const snapshot = { ...original, localPath, contentHash: await sha256File(localPath) };
      await expect(prepareFixtureTopology(snapshot)).rejects.toThrow(
        malformation === "duplicate node" ? "duplicate node IDs" : "references missing node missing-node",
      );
    },
  );

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
    await expect(prepareFixtureTopology(snapshot)).rejects.toThrow("Content hash mismatch");
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
