import { describe, expect, it } from "vitest";
import { collections, coverageExclusions, coverageSources, planCoverageGeometry } from "./collections";
import { rectangle, unionCoverage } from "./geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";

describe("coverage source geography", () => {
  it("uses provider geometry independently from collection envelopes", async () => {
    const sources = await coverageSources();
    expect(sources).toHaveLength(2);
    const washington = sources.find((source) => source.config.id === "geofabrik-washington-osm")!;
    expect(coordinateIsInsideArea([-121.8, 48.1], washington.geometry)).toBe(true);
    expect(coordinateIsInsideArea([-121.5, 45.5], washington.geometry)).toBe(false);
    const cascades = (await collections()).find((collection) => collection.id === "washington-cascades")!;
    expect(coordinateIsInsideArea([-121.5, 45.5], cascades.geometry)).toBe(true);
    expect(cascades.sourceIds).toEqual([washington.config.id]);
  });

  it("uses the IBC mainland line to reject Canadian BR717 while retaining US border trails", async () => {
    const washington = (await coverageSources()).find((source) => source.config.id === "geofabrik-washington-osm")!;
    // Complete OSM way/1186146299 node sequence from the pinned August 1 Washington extract.
    const br717CanadianNodes: [number, number][] = [
      [-121.7855031, 49.0040326], // OSM node/11017326745
      [-121.7848086, 49.0040854], // OSM node/11017326746
      [-121.7839331, 49.0040319], // OSM node/11017326747
      [-121.7834481, 49.003939], // OSM node/11017326748
      [-121.78278, 49.0037004], // OSM node/11017326749
      [-121.782116, 49.003395], // OSM node/11017326750
      [-121.7816072, 49.003092], // OSM node/11017326751
      [-121.7811308, 49.0027937], // OSM node/11017326752
      [-121.7807988, 49.0026872], // OSM node/11017326753
      [-121.7804163, 49.0024646], // OSM node/11017326754
      [-121.7800157, 49.0021356], // OSM node/11017326755
      [-121.7794094, 49.0016573], // OSM node/11017326756
      [-121.778648, 49.0010584], // OSM node/11017326757
      [-121.7778144, 49.0004831], // OSM node/11017326758
      [-121.7772695, 49.000154], // OSM node/11017326759
      [-121.7763673, 48.9998604], // OSM node/11017326760
      [-121.7755084, 48.9996094], // OSM node/11017326761
      [-121.7747794, 48.9993632], // OSM node/11017326762
      [-121.7742742, 48.9991099], // OSM node/11017326763
      [-121.7737582, 48.9988542], // OSM node/11017326764
      [-121.7735669, 48.9987429], // OSM node/11017326765
      [-121.7734298, 48.9985464], // OSM node/11017326766
      [-121.773372, 48.9983807], // OSM node/11017326767
      [-121.7733973, 48.9982126], // OSM node/11017326768
      [-121.7734839, 48.9978574], // OSM node/11017326769
      [-121.7735538, 48.9977002], // OSM node/11017326770
      [-121.7736023, 48.9976701], // OSM node/11017326771
      [-121.7736891, 48.99766], // OSM node/11017326772
      [-121.7737809, 48.9976701], // OSM node/11017326773
      [-121.77386, 48.9976969], // OSM node/11017326774
      [-121.7739493, 48.9977655], // OSM node/11017326775
      [-121.7742428, 48.9980468], // OSM node/11017326776
      [-121.774623, 48.9983833], // OSM node/11017326777
      [-121.7747863, 48.9984921], // OSM node/11017326778
      [-121.7748858, 48.998539], // OSM node/11017326779
      [-121.7750951, 48.9986059], // OSM node/11017326780
      [-121.775289, 48.9986545], // OSM node/11017326781
      [-121.7756361, 48.9987935], // OSM node/11017326782
      [-121.7760239, 48.9989324], // OSM node/11017326783
      [-121.7765088, 48.9991048], // OSM node/11017326784
    ];
    expect(br717CanadianNodes).toHaveLength(40);
    for (const point of br717CanadianNodes) expect(coordinateIsInsideArea(point, washington.geometry)).toBe(false);
    // OSM node/677621543 on Chilliwack River Trail way/53658218 lies south of the IBC line.
    expect(coordinateIsInsideArea([-121.4077738, 48.9998624], washington.geometry)).toBe(true);
    // Interior regression points near West Cady Ridge and Mount Pilchuck retain coverage.
    expect(coordinateIsInsideArea([-121.4, 47.9], washington.geometry)).toBe(true);
    expect(coordinateIsInsideArea([-121.8, 48.05], washington.geometry)).toBe(true);
  });

  it("keeps Yakama excluded from both collection and drawn installation plans", async () => {
    const exclusions = await coverageExclusions();
    const point: [number, number] = [-120.8, 46.2];
    expect(coordinateIsInsideArea(point, exclusions[0]!.geometry)).toBe(true);
    const cascades = (await collections()).find((collection) => collection.id === "washington-cascades")!;
    expect(coordinateIsInsideArea(point, cascades.geometry)).toBe(false);
    const plan = planCoverageGeometry(rectangle([-120.81, 46.19, -120.79, 46.21]), await coverageSources(), exclusions);
    expect(plan.supported).toBeNull();
    expect(plan.units.every((unit) => unit.status === "unavailable" && unit.reason === "intentionally-excluded:yakama-reservation")).toBe(true);
  });

  it("splits a cell across all source extents, preserves the request, and gives unsupported pieces a stable identity", () => {
    const requested = rectangle([0, 0, 0.25, 0.25]);
    const sources = [{ geometry: rectangle([0, 0, 0.1, 0.25]) }, { geometry: rectangle([0.15, 0, 0.25, 0.25]) }];
    const plan = planCoverageGeometry(requested, sources, []);
    expect(plan.units).toHaveLength(2);
    const available = plan.units.find((unit) => unit.status === "pending")!;
    const unavailable = plan.units.find((unit) => unit.status === "unavailable")!;
    expect(coordinateIsInsideArea([0.125, 0.1], available.geometry)).toBe(false);
    expect(coordinateIsInsideArea([0.125, 0.1], unavailable.geometry)).toBe(true);
    expect(available.id).not.toBe(unavailable.id);
    expect(planCoverageGeometry(requested, [...sources].reverse(), [])).toEqual(plan);
    const rebuilt = unionCoverage(plan.units.map((unit) => unit.geometry));
    for (const x of [0.05, 0.125, 0.2]) expect(coordinateIsInsideArea([x, 0.1], rebuilt)).toBe(true);
  });

  it("marks an unsupported request unavailable even when no providers are configured", () => {
    const plan = planCoverageGeometry(rectangle([1, 1, 1.1, 1.1]), [], []);
    expect(plan.supported).toBeNull();
    expect(plan.units[0]?.reason).toBe("outside-configured-source-coverage");
  });
});
