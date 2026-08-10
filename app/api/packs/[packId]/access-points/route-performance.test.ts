import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadRoutePacks: vi.fn(),
}));

vi.mock("@/lib/server/pack-registry", () => ({
  loadRoutePacks: mocks.loadRoutePacks,
}));

import { GET } from "./route";

describe("mapped trail access-point API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates request cancellation and deduplicates directed edges by physical identity", async () => {
    const close = vi.fn(async () => undefined);
    const getInducedGraph = vi.fn(async () => ({
      nodes: new Map(),
      edges: [
        {
          id: "forward", edgeKey: 1, physicalEdgeKey: 10, fromNodeId: "a", toNodeId: "b",
          coordinates: [[-122.2, 37.1], [-122.1, 37.2]], lengthMeters: 100,
          gainMeters: 5, lossMeters: 0, maximumElevationMeters: 50, maximumSustainedGradePct: 5,
          accessState: "public", edgeClass: "trail", trailName: "Test Trail", sourceIds: ["fixture"], flags: [],
        },
        {
          id: "reverse", edgeKey: 2, physicalEdgeKey: 10, fromNodeId: "b", toNodeId: "a",
          coordinates: [[-122.1, 37.2], [-122.2, 37.1]], lengthMeters: 100,
          gainMeters: 0, lossMeters: 5, maximumElevationMeters: 50, maximumSustainedGradePct: 5,
          accessState: "public", edgeClass: "trail", trailName: "Test Trail", sourceIds: ["fixture"], flags: [],
        },
      ],
    }));
    const repository = {
      packId: "test-pack",
      getAccessPoints: vi.fn(async () => []),
      getAccessPointCandidates: vi.fn(async () => []),
      getInducedGraph,
      getReachableGraph: vi.fn(),
      close,
    };
    const loadRepository = vi.fn(async () => repository);
    mocks.loadRoutePacks.mockResolvedValue(new Map([
      ["test-pack", { kind: "installed", loadRepository }],
    ]));
    const request = new Request(
      "http://localhost/api/packs/test-pack/access-points?bbox=-122.3,37,-122,37.3&includeAccessPoints=false",
      { signal: new AbortController().signal },
    );

    const response = await GET(request, { params: Promise.resolve({ packId: "test-pack" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(loadRepository).toHaveBeenCalledWith(request.signal);
    expect(getInducedGraph).toHaveBeenCalledWith(expect.objectContaining({ signal: request.signal }));
    expect(body.trailNetwork.features).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });
});
