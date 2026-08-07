import { describe, expect, it } from "vitest";
import { listRegionalPackBuilderIds, requireRegionalPackBuilder } from "./regional-pack";

describe("regional pack builder registry", () => {
  it("registers the active Santa Cruz builder", () => {
    expect(listRegionalPackBuilderIds()).toEqual(["santa-cruz-mountains"]);
    expect(requireRegionalPackBuilder("santa-cruz-mountains")).toEqual(expect.any(Function));
  });

  it("distinguishes planned regions from unknown pack ids", () => {
    expect(() => requireRegionalPackBuilder("southern-east-bay")).toThrow(/planned.*does not have a pack builder/i);
    expect(() => requireRegionalPackBuilder("not-a-region")).toThrow(/unknown regional pack/i);
  });
});
