import { describe, expect, it } from "vitest";
import { classifyOsmWay, osmAccessState, osmEvidenceFlags, osmFootDirection, osmMotorAccessState, osmNodeFlags, osmWayFlags } from "./normalize";

describe("OSM tag classification", () => {
  it("distinguishes an explicit place foot condition from missing parking access",()=>{
    expect(osmEvidenceFlags({amenity:"parking",motorcar:"yes"})).not.toContain("foot-access:unknown");
    expect(osmEvidenceFlags({amenity:"parking",foot:"yes","foot:conditional":"no @ (snow)"})).toEqual(expect.arrayContaining([
      "foot-access:unknown","osm-foot:conditional:no @ (snow)",
    ]));
    expect(osmEvidenceFlags({amenity:"parking",access:"private",foot:"yes"})).toContain("foot-access:public");
  });
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
    expect(classifyOsmWay({ highway: "unclassified", name: "Ridge Trail connector" })).toBe("street");
    expect(classifyOsmWay({ highway: "service", name: "Trail Walk" })).toBe("service-road");
    expect(classifyOsmWay({ highway: "footway" })).toBe("trail");
    expect(classifyOsmWay({ highway: "pedestrian" })).toBe("trail");
    expect(osmWayFlags({ highway: "footway" }, "way/1", "both")).toContain("possible-walking-link");
    expect(osmWayFlags({ highway: "footway", footway: "sidewalk" }, "way/2", "both")).not.toContain("possible-walking-link");
    expect(classifyOsmWay({ highway: "footway", name: "Ridge Trail" })).toBe("trail");
    expect(osmWayFlags({ highway: "footway", name: "Ridge Trail", surface: "dirt" }, "way/3", "both")).toContain("possible-walking-link");
    expect(classifyOsmWay({ highway: "footway", sac_scale: "hiking" })).toBe("trail");
    for (const footway of ["sidewalk", "crossing", "traffic_island", "access_aisle", "link"]) {
      expect(classifyOsmWay({ highway: "footway", footway })).toBe("sidewalk");
      expect(classifyOsmWay({ highway: "service", foot: "yes", footway })).toBe("sidewalk");
    }
    expect(classifyOsmWay({ highway: "service", service: "parking_aisle" })).toBe("service-road");
    expect(classifyOsmWay({ highway: "track" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", access: "private" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", motor_vehicle: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", vehicle: "designated" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", access: "yes" })).toBe("trail");
    expect(classifyOsmWay({ highway: "track", motor_vehicle: "yes", foot: "no" })).toBe("trail");
    for (const highway of ["path", "footway", "pedestrian", "steps", "bridleway"])
      expect(classifyOsmWay({ highway, area: "yes", foot: "yes" })).toBe("sidewalk");
    expect(classifyOsmWay({ highway: "construction" })).toBeNull();
  });

  it("separates foot permission, purpose restrictions and motor permission", () => {
    const values = { highway: "track", foot: "yes", motorcar: "private", access: "no" };
    expect(osmAccessState(values)).toBe("public");
    expect(osmMotorAccessState(values)).toBe("private");
    expect(osmWayFlags(values, "way/1", "both")).toEqual(expect.arrayContaining([
      "osm-highway:track", "motor-access:private", "osm-foot:yes", "osm-access:no",
    ]));
    expect(osmAccessState({ foot: "delivery" })).toBe("private");
    expect(osmAccessState({ foot: "agricultural" })).toBe("prohibited");
    expect(osmAccessState({ access: "closed" })).toBe("closed");
    expect(osmMotorAccessState({ motorcar: "yes", vehicle: "no" })).toBe("public");
  });

  it("retains unresolved conditions without erasing known foot restrictions", () => {
    expect(osmAccessState({ foot: "yes", "foot:conditional": "no @ (winter)" })).toBe("unknown");
    expect(osmAccessState({ foot: "private", "foot:conditional": "yes @ (Mo-Fr)" })).toBe("private");
    expect(osmAccessState({ access: "no", "access:conditional": "yes @ (summer)" })).toBe("prohibited");
    expect(osmAccessState({ foot: "yes", access: "private", "access:conditional": "no @ (winter)" })).toBe("public");
    expect(osmWayFlags({ highway: "path", foot: "private", "foot:conditional": "yes @ (Mo-Fr)" }, "way/1", "both"))
      .toContain("osm-foot:conditional:yes @ (Mo-Fr)");
    expect(osmMotorAccessState({ motorcar: "yes", "vehicle:conditional": "no @ (winter)" })).toBe("public");
  });

  it("uses pedestrian direction separately from vehicle one-way rules", () => {
    for (const highway of ["track", "service", "residential", "primary", "road"]) {
      expect(osmFootDirection({ highway, oneway: "yes", foot: "yes" })).toBe("both");
      expect(osmFootDirection({ highway, oneway: "-1", "oneway:foot": "no" })).toBe("both");
      expect(osmFootDirection({ highway, oneway: "yes", "foot:forward": "no" })).toBe("reverse");
      expect(osmFootDirection({ highway, "oneway:foot": "-1" })).toBe("reverse");
      const forbidden = { highway, foot: "yes", "foot:forward": "no", "foot:backward": "no" };
      expect(osmAccessState(forbidden)).toBe("prohibited");
      expect(osmWayFlags(forbidden, "way/1", osmFootDirection(forbidden))).toContain("foot-direction:none");
    }
    expect(osmFootDirection({ highway: "path", oneway: "-1" })).toBe("reverse");
    expect(osmAccessState({ highway: "path", foot: "yes", "oneway:foot": "yes", "foot:forward": "no" })).toBe("prohibited");
    const reverse = { highway: "track", foot: "no", "foot:backward": "yes" };
    expect(osmAccessState(reverse)).toBe("public");
    expect(osmWayFlags(reverse, "way/1", osmFootDirection(reverse))).toEqual(expect.arrayContaining([
      "foot-forward-access:prohibited", "foot-backward-access:public",
    ]));
  });

  it("encodes actual crossing restrictions and leaves object metadata separate", () => {
    expect(osmNodeFlags({ barrier: "gate" })).toEqual(["barrier:gate"]);
    expect(osmNodeFlags({ barrier: "bollard", foot: "yes", motor_vehicle: "no" })).toEqual(expect.arrayContaining([
      "barrier:bollard", "foot-access:public", "motor-access:prohibited",
    ]));
    expect(osmNodeFlags({ access: "private" })).toContain("foot-access:private");
    expect(osmNodeFlags({ barrier: "gate", access: "private", foot: "yes" })).toContain("foot-access:public");
    for (const object of [{ information: "board" }, { tourism: "information" }, { amenity: "parking" }] as Record<string,string>[]) {
      expect(osmNodeFlags({ ...object, access: "private" })).not.toContain("foot-access:private");
      expect(osmNodeFlags({ ...object, access: "private", barrier: "gate" })).toContain("foot-access:private");
    }
  });
});
