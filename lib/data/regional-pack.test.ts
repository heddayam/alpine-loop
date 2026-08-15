import { describe, expect, it } from "vitest";
import { listRegionalPackBuilderIds, requireRegionalPackBuilder } from "./regional-pack";

describe("regional pack builder registry", () => {
  it("registers active builders in stable pack-ID order", () => {
    expect(listRegionalPackBuilderIds()).toEqual([
      "central-cascades",
      "henry-coe",
      "monterey-carmel",
      "santa-cruz-mountains",
      "southern-east-bay",
    ]);
    expect(requireRegionalPackBuilder("central-cascades")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("henry-coe")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("monterey-carmel")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("santa-cruz-mountains")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("southern-east-bay")).toEqual(expect.any(Function));
  });

  it("distinguishes planned regions from unknown pack ids", () => {
    expect(() => requireRegionalPackBuilder("marin-mount-tam")).toThrow(/planned.*does not have a pack builder/i);
    expect(() => requireRegionalPackBuilder("not-a-region")).toThrow(/unknown regional pack/i);
  });
});
