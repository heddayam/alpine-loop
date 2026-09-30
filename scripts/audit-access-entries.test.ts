import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cycleComponents, profileCounts } from "./audit-access-entries";
import { compiledEdgesForSegment } from "../lib/data/compiled-edges";
import { distanceMeters } from "../lib/data/metrics";
import { normalizeOsmOpl } from "../lib/data/osm/opl";
import { rectangle } from "../lib/coverage/geometry";
import { ConnectedEntryProof, type PreparedEntry } from "../lib/data/progressive/entry-proof";
import { openProgressiveGraphStore } from "../lib/data/progressive/store";
import { selectProgressiveEdges } from "../lib/data/progressive/publish";
import type { CompiledEdge, NormalizedAccessPoint } from "../lib/data/types";

const point = (id: string, accessState: NormalizedAccessPoint["accessState"], nearbyBuildingCount: number) => ({
  id, externalId: id, nodeId: id, lon: 0, lat: 0, name: id, kind: "trailhead" as const,
  accessState, confidence: "low" as const, parkingEvidence: null, sourceRefs: [], nearbyBuildingCount,
});
const edge = (physical: string, fromNode: string, toNode: string, accessState: CompiledEdge["accessState"] = "public"): CompiledEdge => ({
  id: `${physical}:${fromNode}`, stablePhysicalId: physical, fromNode, toNode,
  geometry: [[0, 0], [.001, 0]], lengthM: 100, gainM: null, lossM: null,
  maxElevationM: null, maxSustainedGradePct: null, accessState, edgeClass: "trail", flags: [], sourceRefs: [],
});

async function originalCandidates(fixture: string, stage: "sparse" | "measured") {
  const topology = normalizeOsmOpl(await readFile(`data/fixtures/access-review/${fixture}`, "utf8"), "pinned-source");
  const store = openProgressiveGraphStore({ stagingPath: ":memory:", buildIdentity: fixture });
  const nodes = new Map(topology.nodes.map(node => [node.id, node]));
  const boundary = rectangle([-125, 36, -120, 49]);
  try {
    store.database.exec("CREATE TEMP TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT NOT NULL,to_node TEXT NOT NULL,length_m REAL NOT NULL) STRICT");
    const insert = store.database.prepare("INSERT INTO eligible_segments VALUES (?,?,?,?)");
    store.transaction(() => {
      for (const node of topology.nodes) store.putNode(node);
      for (const evidence of topology.portalEvidence ?? []) store.putPortalEvidence(evidence);
      for (const way of topology.ways) {
        store.putWay(way);
        if (way.edgeClass !== "trail") continue;
        for (let index = 0; index < way.nodeIds.length - 1; index++) {
          const lengthM = distanceMeters(way.coordinates[index]!, way.coordinates[index + 1]!);
          const movements = compiledEdgesForSegment(way, index, way.coordinates.slice(index, index + 2), {
            lengthM, gainM: null, lossM: null, maxElevationM: null, maxSustainedGradePct: null, elevationProfile: null,
          }, { nodeFlags: way.nodeIds.slice(index, index + 2).map(id => nodes.get(id)!.flags) });
          if (!movements.some(edge => ["public", "unknown"].includes(edge.accessState))) continue;
          insert.run(`${way.id}:${index}`, way.nodeIds[index]!, way.nodeIds[index + 1]!, lengthM);
          for (const movement of movements) store.putEdge(movement);
        }
      }
    });
    if (stage === "measured") await selectProgressiveEdges(store, boundary);
    const proof = new ConnectedEntryProof(store.database, async () => {});
    try {
      await proof.prepare(stage); await proof.discover(boundary);
      return new Map((store.database.prepare("SELECT node_id,witness FROM portal_candidates").all() as { node_id: string; witness: string }[])
        .map(row => [row.node_id, JSON.parse(row.witness) as PreparedEntry]));
    } finally { proof.clear(); }
  } finally { store.close(); }
}

describe("offline access-entry audit", () => {
  it("separates detector permission changes from the building-density veto", () => {
    expect(profileCounts([point("known", "public", 9), point("dense", "public", 10),
      point("unknown", "unknown", 0), point("private", "private", 0)])).toEqual({
      inclusiveWithoutDensity: 3, knownWithoutDensity: 2, inclusiveWithDensity: 2, knownWithDensity: 1,
    });
  });

  it("never counts opposing directions of one physical segment as a loop", () => {
    const edges = [edge("ab", "a", "b"), edge("ab", "b", "a"), edge("bc", "b", "c")];
    expect(cycleComponents(edges, "inclusive").get("a")).toMatchObject({
      nodeCount: 3, physicalSegments: 2, lengthMeters: 200, undirectedCyclePotential: false,
    });
    edges.push(edge("ca", "c", "a", "unknown"));
    expect(cycleComponents(edges, "inclusive").get("a")?.undirectedCyclePotential).toBe(true);
    expect(cycleComponents(edges, "known").get("a")?.undirectedCyclePotential).toBe(false);
  });

  it("preserves actual permitted walking across Denny's vehicle-closed service bridge", async () => {
    const raw = await readFile("data/fixtures/access-review/denny-foot-service-frontier.opl", "utf8");
    const topology = normalizeOsmOpl(raw, "pinned-washington");
    const bridge = topology.ways.find(way => way.externalId === "way/607609231")!;
    const gate = topology.nodes.find(node => node.externalId === "node/1969228635")!;
    expect(bridge).toMatchObject({ edgeClass: "trail", accessState: "public", bidirectional: true });
    expect(bridge.flags).toEqual(expect.arrayContaining(["osm-highway:service", "motor-access:prohibited"]));
    expect(gate.flags).toEqual(expect.arrayContaining(["barrier:gate", "foot-access:public", "motor-access:prohibited"]));
    const movements = compiledEdgesForSegment(bridge, 0, [bridge.coordinates[0]!, bridge.coordinates[1]!], {
      lengthM: 20, gainM: null, lossM: null, maxElevationM: null, maxSustainedGradePct: null, elevationProfile: null,
    }, { nodeFlags: bridge.nodeIds.slice(0, 2).map(id => topology.nodes.find(node => node.id === id)!.flags) });
    expect(movements.map(movement => movement.accessState)).toEqual(["public", "public"]);
  });

  it("retains unknown reverse walking on original generic one-way mountain-bike paths", async () => {
    const raw = await readFile("data/fixtures/access-review/tiger-generic-mtb-oneway.opl", "utf8");
    const topology = normalizeOsmOpl(raw, "pinned-washington");
    expect(topology.ways).toHaveLength(2);
    for (const way of topology.ways) {
      expect(way).toMatchObject({ edgeClass: "trail", accessState: "unknown", bidirectional: true });
      const movements = compiledEdgesForSegment(way, 0, [way.coordinates[0]!, way.coordinates[1]!], {
        lengthM: 20, gainM: null, lossM: null, maxElevationM: null, maxSustainedGradePct: null, elevationProfile: null,
      }, { nodeFlags: way.nodeIds.slice(0, 2).map(id => topology.nodes.find(node => node.id === id)!.flags) });
      expect(movements.map(movement => movement.accessState)).toEqual(["unknown", "unknown"]);
    }
  });

  it("does not convert the original NorCal track-area footprint into a trail circuit", async () => {
    const raw = await readFile("data/fixtures/access-review/norcal-track-area.opl", "utf8");
    const topology = normalizeOsmOpl(raw, "pinned-norcal");
    const area = topology.ways.find(way => way.externalId === "way/356872374")!;
    expect(area.nodeIds[0]).toBe(area.nodeIds.at(-1));
    expect(area.flags).toEqual(expect.arrayContaining(["osm-highway:track", "area:yes"]));
    expect(topology.ways.filter(way => way.edgeClass === "trail")).toEqual([]);
  });

  describe.each(["sparse", "measured"] as const)("original-source entry proof (%s)", stage => {
    it("uses Top's actual turning-circle arrival place without claiming its tracks motor-public", async () => {
      const candidates = await originalCandidates("top-lake-connected-approach.opl", stage);
      expect(candidates.get("osm-node-3761092325")).toMatchObject({ known: true, rootNodeId: "osm-node-3761092325" });
      expect(candidates.get("osm-node-3761092329")).toMatchObject({ kind: "trailhead", known: true, rootNodeId: "osm-node-3761092325" });
    });

    it("does not propagate unknown-track arrival through Sunol's full ordinary-road approach", async () => {
      const candidates = await originalCandidates("sunol-interior-rooted-approach.opl", stage);
      expect(candidates.has("osm-node-53105842")).toBe(true);
      for (const node of ["1107300663", "1107300713", "1406776609"]) expect(candidates.has(`osm-node-${node}`)).toBe(false);
    });

    it.each(["discovery-restricted-turning-circle.opl", "alum-golf-turning-circle.opl", "tiger-private-road-trail-contact.opl"])("does not seed arrival from unsupported or restricted source context in %s", async fixture => {
      expect((await originalCandidates(fixture, stage)).size).toBe(0);
    });
  });
});
