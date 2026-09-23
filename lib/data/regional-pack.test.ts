import { describe, expect, it } from "vitest";
import { listRegionalPackBuilderIds, requireRegionalPackBuilder } from "./regional-pack";

describe("regional pack builder registry", () => {
  it("registers active builders in stable pack-ID order", () => {
    expect(listRegionalPackBuilderIds()).toEqual([
      "central-cascades",
      "henry-coe",
      "monterey-carmel",
      "north-cascades",
      "olympic-peninsula",
      "rainier-goat-rocks",
      "santa-cruz-mountains",
      "southern-east-bay",
      "southwest-cascades",
    ]);
    expect(requireRegionalPackBuilder("central-cascades")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("henry-coe")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("monterey-carmel")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("north-cascades")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("olympic-peninsula")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("rainier-goat-rocks")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("santa-cruz-mountains")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("southern-east-bay")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("southwest-cascades")).toEqual(expect.any(Function));
  });

  it("distinguishes planned regions from unknown pack ids", () => {
    for (const id of [
      "marin-mount-tam",
    ]) {
      expect(() => requireRegionalPackBuilder(id)).toThrow(/planned.*does not have a pack builder/i);
    }
    expect(() => requireRegionalPackBuilder("not-a-region")).toThrow(/unknown regional pack/i);
  });
});
