import { describe, expect, it } from "vitest";
import type { RoutePack } from "./route-pack";
import { createSearchRegionListHandler } from "./search-regions-api";

const basePack = {
  id: "fixture",
  schemaVersion: "4",
  dataVersion: "fixture-v4",
  builtAt: "2026-08-06T00:00:00Z",
  coverageBbox: [-1, -1, 1, 1],
  coverage: { type: "Polygon", coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] },
  maximumAreaSquareKilometers: 100,
  loadRepository: async () => { throw new Error("unused"); },
} as unknown as RoutePack;

describe("search-region discovery API", () => {
  it("returns only the pack-reviewed ordered catalog", async () => {
    const region = {
      id: "pack:fixture",
      name: "Fixture Range",
      kind: "pack" as const,
      bbox: [-1, -1, 1, 1] as [number, number, number, number],
      sourceIds: ["fixture"],
      displayOrder: 0,
    };
    const pack = { ...basePack, listSearchRegions: () => [region] };
    const response = await createSearchRegionListHandler({ packs: new Map([[pack.id, pack]]) })(
      new Request("http://local/api/packs/fixture/search-regions"),
      pack.id,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ regions: [region] });
  });

  it("distinguishes missing packs from packs without the capability", async () => {
    const missing = await createSearchRegionListHandler({ packs: new Map() })(new Request("http://local"), "missing");
    expect(missing.status).toBe(404);
    const unavailable = await createSearchRegionListHandler({ packs: new Map([[basePack.id, basePack]]) })(
      new Request("http://local"),
      basePack.id,
    );
    expect(unavailable.status).toBe(422);
  });
});
