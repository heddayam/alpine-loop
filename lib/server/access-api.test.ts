import { describe, expect, it, vi } from "vitest";
import type { NamedArea } from "@/lib/contracts";
import type { AccessPointCandidate, GraphRepository, InducedGraph } from "@/lib/graph";
import { createAccessPreviewHandler } from "./access-preview";
import { createNamedAreaDetailHandler, createNamedAreaSearchHandler } from "./named-areas-api";
import type { RoutePack } from "./route-pack";

const REGION: NamedArea = {
  id: "osm:relation/42",
  name: "Hole Preserve",
  kind: "preserve",
  bbox: [0, 0, 10, 10],
  sourceIds: ["osm"],
  geometry: {
    type: "Polygon",
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  },
};

function candidate(id: string, lon: number, lat: number, accessState: "public" | "unknown" = "public"): AccessPointCandidate {
  return {
    id, nodeId: `node-${id}`, name: id, kind: "trailhead", accessState,
    confidence: "high", parkingEvidence: null, sourceIds: ["osm"], lon, lat,
    knownConnectivity: 10, inclusiveConnectivity: 12, knownOutDegree: 2, inclusiveOutDegree: 3,
    nearbyBuildingCount: 0,
  };
}

class PreviewRepository implements GraphRepository {
  readonly packId = "fixture-pack";
  close = vi.fn(async () => undefined);
  constructor(readonly candidates: AccessPointCandidate[]) {}
  async getInducedGraph(): Promise<InducedGraph> { return { nodes: new Map(), edges: [], accessPoints: [] }; }
  async getAccessPoints(): Promise<[]> { return []; }
  async getAccessPointCandidates(): Promise<AccessPointCandidate[]> { return this.candidates; }
  async getReachableGraph() { return { graph: await this.getInducedGraph(), truncated: false }; }
}

function pack(repository = new PreviewRepository([])): RoutePack {
  return {
    id: "fixture-pack", schemaVersion: "2", dataVersion: "fixture-v2", builtAt: "2026-08-04T00:00:00Z",
    coverageBbox: [-1, -1, 11, 11],
    coverage: { type: "Polygon", coordinates: [[[-1, -1], [11, -1], [11, 11], [-1, 11], [-1, -1]]] },
    maximumAreaSquareKilometers: 100,
    searchNamedAreas: async (text) => text.includes("hole") ? [{
      id: REGION.id, name: REGION.name, kind: REGION.kind, bbox: REGION.bbox, sourceIds: REGION.sourceIds,
    }] : [],
    getNamedArea: async (id) => id === REGION.id ? REGION : null,
    loadRepository: async () => repository,
  };
}

const reachability = async () => ({
  geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]]] },
  durationMinutes: 30,
  resolvedAt: "2026-08-04T00:00:00Z",
  originLabel: "Origin",
});

function previewRequest(body: unknown): Request {
  return new Request("http://localhost/api/packs/fixture-pack/access-points/preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("access-point preview API", () => {
  it("applies polygon holes, boundary inclusion, and unknown-access policy", async () => {
    const repository = new PreviewRepository([
      candidate("inside", 2, 2),
      candidate("hole-interior", 5, 5),
      candidate("hole-boundary", 4, 5),
      candidate("unknown", 3, 3, "unknown"),
      candidate("outside", 12, 12),
    ]);
    const handler = createAccessPreviewHandler({
      packs: new Map([["fixture-pack", pack(repository)]]),
      resolveReachability: reachability,
    });
    const response = await handler(previewRequest({
      accessFilter: { mode: "named-region", regionId: REGION.id },
      includeUncertainAccess: false,
    }), "fixture-pack");
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      resolvedAccessFilter: { mode: string };
      filterGeometry: { type: string };
      accessPoints: Array<{ id: string }>;
    };
    expect(payload.resolvedAccessFilter.mode).toBe("named-region");
    expect(payload.filterGeometry.type).toBe("Polygon");
    expect(payload.accessPoints.map(({ id }) => id)).toEqual(["hole-boundary", "inside"]);
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it("returns both drive and named refinement geometry", async () => {
    const handler = createAccessPreviewHandler({
      packs: new Map([["fixture-pack", pack(new PreviewRepository([candidate("inside", 2, 2)]))]]),
      resolveReachability: reachability,
    });
    const response = await handler(previewRequest({
      accessFilter: {
        mode: "drive-time",
        reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc",
        regionId: REGION.id,
      },
      includeUncertainAccess: true,
    }), "fixture-pack");
    const payload = await response.json() as { filterGeometry: unknown; refinementGeometry: unknown; accessPoints: unknown[] };
    expect(payload.filterGeometry).toBeDefined();
    expect(payload.refinementGeometry).toEqual(REGION.geometry);
    expect(payload.accessPoints).toHaveLength(1);
  });

  it("drops starts surrounded by buildings", async () => {
    const wild = candidate("wild", 2, 2);
    const edgeOfTown = candidate("edge-of-town", 3, 3);
    edgeOfTown.nearbyBuildingCount = 49;
    const neighbourhood = candidate("neighbourhood", 7, 7);
    neighbourhood.nearbyBuildingCount = 50;
    const handler = createAccessPreviewHandler({
      packs: new Map([["fixture-pack", pack(new PreviewRepository([wild, edgeOfTown, neighbourhood]))]]),
      resolveReachability: reachability,
    });

    const response = await handler(previewRequest({
      accessFilter: { mode: "drawn-area", bbox: [0, 0, 10, 10] },
      includeUncertainAccess: true,
    }), "fixture-pack");
    const payload = await response.json() as { accessPoints: Array<{ id: string }> };
    expect(payload.accessPoints.map(({ id }) => id).sort()).toEqual(["edge-of-town", "wild"]);
  });

  it("returns structured validation and pack errors", async () => {
    const handler = createAccessPreviewHandler({ packs: new Map([["fixture-pack", pack()]]), resolveReachability: reachability });
    expect((await handler(previewRequest({ accessFilter: {} }), "fixture-pack")).status).toBe(400);
    expect((await handler(previewRequest({
      accessFilter: { mode: "drawn-area", bbox: [0, 0, 1, 1] },
      includeUncertainAccess: true,
    }), "missing")).status).toBe(404);
  });
});

describe("named-area catalog API", () => {
  const packs = new Map([["fixture-pack", pack()]]);

  it("searches local aliases and requires explicit detail lookup", async () => {
    const search = createNamedAreaSearchHandler({ packs });
    const searchResponse = await search(new Request("http://localhost/named-areas?q=hole"), "fixture-pack");
    expect((await searchResponse.json() as { regions: Array<{ id: string }> }).regions[0]?.id).toBe(REGION.id);

    const detail = createNamedAreaDetailHandler({ packs });
    const detailResponse = await detail(new Request("http://localhost/detail"), "fixture-pack", REGION.id);
    expect((await detailResponse.json() as { region: NamedArea }).region.geometry).toEqual(REGION.geometry);
    expect((await detail(new Request("http://localhost/detail"), "fixture-pack", "missing")).status).toBe(404);
  });

  it("rejects invalid searches and packs without a catalog", async () => {
    const search = createNamedAreaSearchHandler({ packs });
    expect((await search(new Request("http://localhost/named-areas?q=x"), "fixture-pack")).status).toBe(400);
    const noCatalog = pack();
    delete noCatalog.searchNamedAreas;
    expect((await createNamedAreaSearchHandler({ packs: new Map([[noCatalog.id, noCatalog]]) })(
      new Request("http://localhost/named-areas?q=valid"), noCatalog.id,
    )).status).toBe(422);
  });
});
