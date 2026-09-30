import { expect, test } from "vitest";
import { generatedClosedRouteV3Schema, type GeneratedClosedRouteV3 } from "@/lib/contracts";
import { namespaceRoute } from "./identity";

function route(): GeneratedClosedRouteV3 {
  return {
    id: "route",
    geometry: { type: "LineString", coordinates: [[0, 0], [0.001, 0], [0, 0]] },
    startAccessPoint: { id: "start", name: "Start", lon: 0, lat: 0, accessState: "public", confidence: "high" },
    distanceMeters: 300,
    elevationGainMeters: 10,
    elevationLossMeters: 10,
    minimumElevationMeters: 100,
    maximumElevationMeters: 110,
    steepestSustainedGradePct: 5,
    trailNames: ["Fixture trail"],
    warnings: [],
    source: { freshness: "2026-01-01T00:00:00.000Z", confidence: "high", sourceIds: ["fixture"] },
    topology: { kind: "simple-loop", cycleCount: 1, cycleBlockCount: 1, repeatedTrailDistanceMeters: 0,
      repeatedTrailFraction: 0, sharedStemDistanceMeters: 0, connectorCount: 0 },
  };
}

test("namespaces entrance families per installed graph while retaining the exact cycle signature", () => {
  const original = route();
  original.startAccessPoint.entranceFamilyId = `entrance-family:${"1".repeat(64)}`;
  original.physicalLoopId = `physical-loop-v1:${"2".repeat(64)}`;
  const first = namespaceRoute(original, "installation-a", "First area");
  const second = namespaceRoute(original, "installation-b", "Second area");
  expect(first.startAccessPoint.id).toBe("installation-a::start");
  expect(first.startAccessPoint.entranceFamilyId).toBe(`installation-a::${original.startAccessPoint.entranceFamilyId}`);
  expect(second.startAccessPoint.entranceFamilyId).not.toBe(first.startAccessPoint.entranceFamilyId);
  expect(first.physicalLoopId).toBe(original.physicalLoopId);
  expect(second.physicalLoopId).toBe(original.physicalLoopId);
  expect(first.geometry).toEqual(original.geometry);
  expect(first.distanceMeters).toBe(original.distanceMeters);
  expect(original.startAccessPoint.id).toBe("start");
  const { regionLabel, ...firstRecord } = first;
  expect(regionLabel).toBe("First area");
  expect(generatedClosedRouteV3Schema.parse(firstRecord)).toMatchObject({ physicalLoopId: original.physicalLoopId });
});

test("legacy saved routes remain readable without invented entrance or physical cycle metadata", () => {
  const legacy = generatedClosedRouteV3Schema.parse(route());
  const namespaced = namespaceRoute(legacy, "old-installation", "Legacy area");
  expect(namespaced.startAccessPoint.id).toBe("old-installation::start");
  expect(namespaced.startAccessPoint).not.toHaveProperty("entranceFamilyId");
  expect(namespaced).not.toHaveProperty("physicalLoopId");
  const { regionLabel, ...namespacedRecord } = namespaced;
  expect(regionLabel).toBe("Legacy area");
  expect(generatedClosedRouteV3Schema.parse(namespacedRecord)).toEqual({
    ...legacy, id: namespaced.id, startAccessPoint: namespaced.startAccessPoint,
  });
});
