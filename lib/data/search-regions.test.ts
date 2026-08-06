import { describe, expect, it } from "vitest";
import type { NormalizedNamedArea } from "./types";
import { validateSearchRegions, type SearchRegionInput } from "./search-regions";

const geometry: NormalizedNamedArea["geometry"] = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
};

function area(overrides: Partial<NormalizedNamedArea> = {}): NormalizedNamedArea {
  return {
    id: "area:open",
    name: "Open Preserve",
    kind: "preserve",
    aliases: ["Open Preserve"],
    bbox: [0, 0, 1, 1],
    geometry,
    sourceIds: ["source"],
    ...overrides,
  };
}

function input(regions: SearchRegionInput["regions"]): SearchRegionInput {
  return { version: 1, regions };
}

describe("reviewed search regions", () => {
  it("preserves reviewed order and exact named-area references", () => {
    const areas = [area(), area({ id: "area:park", name: "State Park", kind: "park" })];
    expect(validateSearchRegions(input([
      { namedAreaId: "area:park", expectedName: "State Park" },
      { namedAreaId: "area:open", expectedName: "Open Preserve" },
    ]), areas)).toEqual([
      { namedAreaId: "area:park", displayOrder: 0 },
      { namedAreaId: "area:open", displayOrder: 1 },
    ]);
  });

  it("rejects duplicate, missing, renamed, unsupported, and closed-area targets", () => {
    const open = area();
    expect(() => validateSearchRegions(input([
      { namedAreaId: open.id, expectedName: open.name },
      { namedAreaId: open.id, expectedName: open.name },
    ]), [open])).toThrow("Duplicate search region");
    expect(() => validateSearchRegions(input([
      { namedAreaId: "area:missing", expectedName: "Missing" },
    ]), [open])).toThrow("unknown named area");
    expect(() => validateSearchRegions(input([
      { namedAreaId: open.id, expectedName: "Old Name" },
    ]), [open])).toThrow("expected name");
    expect(() => validateSearchRegions(input([
      { namedAreaId: "area:city", expectedName: "City" },
    ]), [area({ id: "area:city", name: "City", kind: "city" })])).toThrow("unsupported kind city");
    expect(() => validateSearchRegions(input([
      { namedAreaId: "area:closed", expectedName: "Preserve Closed Area" },
    ]), [area({ id: "area:closed", name: "Preserve Closed Area" })])).toThrow("closed-area variant");
  });
});
