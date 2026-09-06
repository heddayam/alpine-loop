import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CreateBatchRouteJobV1 } from "@/lib/contracts";
import { RouteJobSolverProcess } from "./route-job-solver-process";
import { routeJobSolverRequestAccessFilter, type RouteJobSolverWorkerInput } from "./route-job-solver-protocol";

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
  },
  routesPerAccessPoint: 10,
};

const input: RouteJobSolverWorkerInput = {
  request,
  pack: { id: "fixture-pack", dataVersion: "v4", builtAt: "2026-01-01T00:00:00.000Z" },
  searchRegionId: request.searchRegionId!,
  driveTimeGeometry: {
    type: "Polygon",
    coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]],
  },
};

describe("RouteJobSolverProcess", () => {
  it("keeps a drawn bbox as the solver filter for every per-access-point effort", () => {
    const drawnAreaBbox: [number, number, number, number] = [-122.4, 37.1, -122.2, 37.3];
    const drawnInput: RouteJobSolverWorkerInput = {
      request: {
        ...request,
        origin: undefined,
        durationMinutes: undefined,
        searchRegionId: undefined,
        drawnAreaBbox,
      },
      pack: input.pack,
      searchRegionId: "drawn-area",
    };

    expect(routeJobSolverRequestAccessFilter(drawnInput)).toEqual({ mode: "drawn-area", bbox: drawnAreaBbox });
  });

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

  it("rejects pending work when the child disconnects unexpectedly", async () => {
    const session = await RouteJobSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-job-solver-fixture-child.ts"),
      env: { ALPINE_TEST_DISCONNECT: "1" },
    });

    await expect(session.searchAccessPoint("slow-access", new AbortController().signal))
      .rejects.toThrow("disconnected unexpectedly");
    await session.close();
  });

  it("terminates a child that does not acknowledge graceful close", async () => {
    const session = await RouteJobSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-job-solver-fixture-child.ts"),
      env: { ALPINE_TEST_CLOSE_HANG: "1" },
      closeTimeoutMs: 25,
    });

    await expect(session.close()).rejects.toThrow("did not close within 25 ms");
    await session.close();
  });
});
