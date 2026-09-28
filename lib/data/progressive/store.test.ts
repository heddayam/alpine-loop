import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";
import { openProgressiveGraphStore } from "./store";

it("merges overlapping source provenance without duplicating context or weakening contradictions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "network-context-"));
  const store = openProgressiveGraphStore({ stagingPath: path.join(root, "stage.sqlite"), buildIdentity: "fixture" });
  const node: NormalizedNode = { id: "a", externalId: "node/1", lon: 1, lat: 2, elevationM: null, flags: [], sourceRefs: ["west"] };
  const way: NormalizedWay = { id: "road", externalId: "way/1", nodeIds: ["a", "b"], coordinates: [[1, 2], [2, 2]], name: null, accessState: "public", bidirectional: true, edgeClass: "street", flags: [], sourceRefs: ["west"] };
  const evidence: NormalizedPortalEvidence = { id: "parking", externalId: "node/1", kind: "parking", name: null, nodeIds: ["a"], coordinates: [[1, 2]], accessState: "public", sourceRefs: ["west"] };
  try {
    store.putNode(node);
    store.setNodeElevation(node.id, 120);
    store.putNode({ ...node, sourceRefs: ["east"] });
    store.putWay(way);
    store.putWay({ ...way, sourceRefs: ["east", "west"] });
    store.putPortalEvidence(evidence);
    store.putPortalEvidence({ ...evidence, sourceRefs: ["east"] });
    for (const table of ["nodes", "ways", "evidence"]) {
      const rows = store.database.prepare(`SELECT record FROM ${table}`).all();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]!.record)).sourceRefs).toEqual(["east", "west"]);
    }
    expect([...store.iterateNodes()][0]!.elevationM).toBe(120);
    expect(store.database.prepare("SELECT count(*) AS n FROM way_nodes").get()!.n).toBe(2);
    expect(store.database.prepare("SELECT count(*) AS n FROM evidence_points").get()!.n).toBe(1);
    expect(() => store.putNode({ ...node, lon: 1.1 })).toThrow("Conflicting");
    expect(() => store.putNode({ ...node, elevationM: 121 })).toThrow("Conflicting elevation");
    expect(() => store.putWay({ ...way, accessState: "private" })).toThrow("Conflicting");
    expect(() => store.putPortalEvidence({ ...evidence, coordinates: [[1.1, 2]] })).toThrow("Conflicting");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
