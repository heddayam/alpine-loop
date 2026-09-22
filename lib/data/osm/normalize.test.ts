import { describe, expect, it } from "vitest";
import { classifyOsmWay, osmAccessState } from "./normalize";

describe("OSM tag classification", () => {
  it("defaults ambiguous access to unknown and retains explicit restrictions", () => {
    expect(osmAccessState({})).toBe("unknown");
    expect(osmAccessState({ access: "no" })).toBe("prohibited");
    expect(osmAccessState({ foot: "private", access: "yes" })).toBe("private");
  });

  it("classifies ways deterministically from road, pedestrian and motor-vehicle context", () => {
    expect(classifyOsmWay({ highway: "path" })).toBe("trail");
    expect(classifyOsmWay({ highway: "residential", name: "Main Street" })).toBe("street");
    expect(classifyOsmWay({ highway: "primary_link" })).toBe("street");
    expect(classifyOsmWay({ highway: "service", foot: "designated" })).toBe("trail");
    expect(classifyOsmWay({ highway: "residential", foot: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "unclassified", name: "Ridge Trail connector" })).toBe("trail");
    expect(classifyOsmWay({ highway: "footway" })).toBe("sidewalk");
    expect(classifyOsmWay({ highway: "footway", name: "Ridge Trail" })).toBe("trail");
    expect(classifyOsmWay({ highway: "footway", sac_scale: "hiking" })).toBe("trail");
    for (const footway of ["sidewalk", "crossing", "traffic_island", "access_aisle", "link"]) {
      expect(classifyOsmWay({ highway: "footway", footway })).toBe("sidewalk");
    }
    expect(classifyOsmWay({ highway: "service", service: "parking_aisle" })).toBe("service-road");
    expect(classifyOsmWay({ highway: "track" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", access: "private" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", motor_vehicle: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", vehicle: "designated" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", access: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", motor_vehicle: "yes", foot: "no" })).toBe("service-road");
    expect(classifyOsmWay({ highway: "construction" })).toBeNull();
  });

});
