import { describe, expect, it } from "vitest";
import registry from "@/data/regions/registry.json";
import { regionRegistryV1Schema } from "./regions";

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
      "central-cascades",
    ]);
    expect(parsed.regions.filter(({ packId }) => packId)).toEqual([
      expect.objectContaining({ id: "santa-cruz-mountains", packId: "santa-cruz-mountains" }),
      expect.objectContaining({ id: "southern-east-bay", packId: "southern-east-bay" }),
      expect.objectContaining({ id: "monterey-carmel", packId: "monterey-carmel" }),
      expect.objectContaining({ id: "henry-coe", packId: "henry-coe" }),
      expect.objectContaining({ id: "central-cascades", packId: "central-cascades" }),
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

});
