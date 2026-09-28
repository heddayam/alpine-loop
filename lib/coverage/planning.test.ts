import { expect, it } from "vitest";
import { COVERAGE_BUILD_VERSION, plan } from "./planning";
import { rectangle } from "./geometry";

it("defers work units until topology discovery and avoids disjoint configured sources", async () => {
  const planned = await plan({ collectionIds: [], geometry: rectangle([-121.9, 48, -121.8, 48.1]), memoryLimitMiB: 512, offline: true });
  expect(planned.units).toEqual([]);
  expect(planned.sourceIds).toEqual(["geofabrik-washington-osm"]);
  expect(COVERAGE_BUILD_VERSION).toMatch(/^connected-networks-v1:/);
});
