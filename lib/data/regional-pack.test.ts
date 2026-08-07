import { describe, expect, it } from "vitest";
import { listRegionalPackBuilderIds, requireRegionalPackBuilder } from "./regional-pack";

describe("regional pack builder registry", () => {
  it("registers active builders in stable pack-ID order", () => {
    expect(listRegionalPackBuilderIds()).toEqual(["santa-cruz-mountains", "southern-east-bay"]);
    expect(requireRegionalPackBuilder("santa-cruz-mountains")).toEqual(expect.any(Function));
    expect(requireRegionalPackBuilder("southern-east-bay")).toEqual(expect.any(Function));
  });

  it("distinguishes planned regions from unknown pack ids", () => {
    expect(() => requireRegionalPackBuilder("monterey-carmel")).toThrow(/planned.*does not have a pack builder/i);
    expect(() => requireRegionalPackBuilder("not-a-region")).toThrow(/unknown regional pack/i);
  });
});
