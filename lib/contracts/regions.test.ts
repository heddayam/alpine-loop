import { describe, expect, it } from "vitest";
import registry from "@/data/regions/registry.json";
import { packCatalogResponseV1Schema, regionRegistryV1Schema } from "./regions";

const PACK = {
  id: "santa-cruz-mountains",
  name: "Santa Cruz Mountains",
  dataVersion: "scm-test",
  builtAt: "2026-08-06T00:00:00.000Z",
  coverageBbox: [-122.57, 36.84, -121.82, 37.44],
  coverage: {
    type: "Polygon",
    coordinates: [[[-122.57, 36.84], [-121.82, 36.84], [-121.82, 37.44], [-122.57, 37.44], [-122.57, 36.84]]],
  },
  display: { center: [-122.18, 37.319], zoom: 13.5 },
};

describe("regional pack catalog contracts", () => {
  it("validates the committed ordered roadmap registry", () => {
    const parsed = regionRegistryV1Schema.parse(registry);
    expect(parsed.regions.map(({ id }) => id)).toEqual([
      "santa-cruz-mountains",
      "southern-east-bay",
      "monterey-carmel",
      "henry-coe",
      "marin-mount-tam",
      "tahoe-eldorado",
    ]);
    expect(parsed.regions.filter(({ packId }) => packId)).toEqual([
      expect.objectContaining({ id: "santa-cruz-mountains", packId: "santa-cruz-mountains" }),
      expect.objectContaining({ id: "southern-east-bay", packId: "southern-east-bay" }),
    ]);
  });

  it("rejects duplicate ids, duplicate display orders, and invalid slugs", () => {
    const duplicate = regionRegistryV1Schema.safeParse({
      version: 1,
      regions: [
        { id: "valid-region", label: "First", displayOrder: 1 },
        { id: "valid-region", label: "Second", displayOrder: 1 },
      ],
    });
    expect(duplicate.success).toBe(false);
    expect(regionRegistryV1Schema.safeParse({
      version: 1,
      regions: [{ id: "Not Valid", label: "Region", displayOrder: 1 }],
    }).success).toBe(false);
  });

  it("requires pack metadata only for available catalog entries", () => {
    const parsed = packCatalogResponseV1Schema.parse({
      version: 1,
      regions: [
        { id: "planned", label: "Planned", displayOrder: 1, state: "planned" },
        { id: "missing", label: "Missing", displayOrder: 2, state: "unavailable", packId: "missing-pack" },
        { id: "ready", label: "Ready", displayOrder: 3, state: "available", packId: PACK.id, pack: PACK },
      ],
    });
    expect(parsed.regions.map(({ state }) => state)).toEqual(["planned", "unavailable", "available"]);
    expect(packCatalogResponseV1Schema.safeParse({
      version: 1,
      regions: [{ id: "ready", label: "Ready", displayOrder: 1, state: "available", packId: PACK.id }],
    }).success).toBe(false);
  });
});
