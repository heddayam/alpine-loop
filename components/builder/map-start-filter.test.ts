import { describe, expect, it } from "vitest";
import type { MapStartFilter, RouteJobV2 } from "@/lib/contracts";
import { mapStartFilterForArea, mapStartFilterForJob } from "./map-start-filter";

const geometry: MapStartFilter["predicates"][number] = { type: "Polygon", coordinates: [
  [[-123,36],[-120,36],[-120,39],[-123,39],[-123,36]],
  [[-122,37],[-121,37],[-121,38],[-122,38],[-122,37]],
] };
const driving = { mode: "drive-time" as const, origin: { lon:-122,lat:37,label:"Home" },durationMinutes:60,minDurationMinutes:15,regionIds:["selected"] };

describe("map start selection parity", () => {
  it("uses named membership without any proximity or outline polygon", () => {
    expect(mapStartFilterForArea({mode:"named-regions",regionIds:["a","b"]},false,geometry)).toEqual({includeUncertainAccess:false,predicates:[],namedRegionIds:["a","b"]});
    expect(mapStartFilterForArea({mode:"named-regions",regionIds:[]},true)).toBeNull();
    expect(mapStartFilterForArea(undefined,true)).toBeNull();
  });
  it("uses the same exact drawn bounds as Full without retaining other area choices", () => {
    expect(mapStartFilterForArea({mode:"drawn-area",bbox:[-122,37,-121,38]},true,geometry)).toEqual({includeUncertainAccess:true,
      predicates:[{type:"Polygon",coordinates:[[[-122,37],[-121,37],[-121,38],[-122,38],[-122,37]]]}]});
  });
  it("requires a resolved drive band and preserves its hole and optional membership", () => {
    expect(mapStartFilterForArea(driving,true)).toBeNull();
    expect(mapStartFilterForArea(driving,false,geometry)).toEqual({includeUncertainAccess:false,predicates:[geometry],namedRegionIds:["selected"]});
    expect(mapStartFilterForArea({...driving,regionIds:[]},true,geometry)).toEqual({includeUncertainAccess:true,predicates:[geometry]});
  });
  it("reads the saved profile and resolved area while queued, resolving and failed driving jobs have no markers", () => {
    const job = {status:"completed",request:{area:driving,criteria:{includeUncertainAccess:false}},area:{label:"Saved",filterGeometry:geometry}} as RouteJobV2;
    expect(mapStartFilterForJob(job)).toEqual({includeUncertainAccess:false,predicates:[geometry],namedRegionIds:["selected"]});
    for (const status of ["queued","resolving-drive-time","failed"] as const) expect(mapStartFilterForJob({...job,status})).toBeNull();
    expect(mapStartFilterForJob({...job,area:{label:"Unresolved"}})).toBeNull();
  });
});
