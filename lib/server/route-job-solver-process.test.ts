import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CreateBatchRouteJobV1 } from "@/lib/contracts";
import { RouteJobSolverProcess } from "./route-job-solver-process";
import type { RouteJobSolverWorkerInput } from "./route-job-solver-protocol";

const request: CreateBatchRouteJobV1 = {
  version: 1,
  packId: "fixture-pack",
  origin: { lon: -122.1, lat: 37.3, label: "Home" },
  durationMinutes: 30,
  searchRegionId: "pack:fixture-pack",
  criteria: {
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 4, max: 8 },
    includeUncertainAccess: true,
    accessPointRemoteness: ["remote"],
  },
  routesPerAccessPoint: 10,
};

const input: RouteJobSolverWorkerInput = {
  request,
  pack: { id: "fixture-pack", dataVersion: "v4", builtAt: "2026-01-01T00:00:00.000Z" },
  searchRegionId: request.searchRegionId,
  driveTimeGeometry: {
    type: "Polygon",
    coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]],
  },
};

describe("RouteJobSolverProcess", () => {
  it("boots the production child entrypoint and reports pinned-pack initialization errors", async () => {
    await expect(RouteJobSolverProcess.open({
      ...input,
      pack: { ...input.pack, id: "definitely-missing-worker-pack" },
    }, new AbortController().signal)).rejects.toThrow("pinned pack version is no longer installed");
  });

  it("keeps the API event loop responsive and terminates a 15-second synchronous solve on cancellation", async () => {
    const session = await RouteJobSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-job-solver-fixture-child.ts"),
      env: { ALPINE_TEST_SOLVE_MS: "15000" },
    });
    expect(await session.enumerateEligibleAccessPointIds(new AbortController().signal)).toEqual(["slow-access"]);

    const controller = new AbortController();
    const startedAt = performance.now();
    const search = session.searchAccessPoint("slow-access", controller.signal);
    const rejection = expect(search).rejects.toMatchObject({ name: "AbortError" });
    let refreshTicks = 0;
    const refresh = setInterval(() => { refreshTicks += 1; }, 5);
    await new Promise<void>((resolveTimer) => setTimeout(resolveTimer, 50));

    expect(refreshTicks).toBeGreaterThan(2);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await rejection;
    clearInterval(refresh);
    await session.close();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
