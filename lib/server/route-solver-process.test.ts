import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { preparedInstallation } from "./__fixtures__/prepared-installation";
import { generatedClosedRouteV3Schema } from "@/lib/contracts";
import { drawnArea } from "./search-area";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SearchIntent } from "@/lib/contracts";
import { RouteSolverProcess } from "./route-solver-process";
import type { RouteSolverWorkerInput } from "./route-solver-protocol";

const request: SearchIntent = {
  area: { mode: "drawn-area", bbox: [-123, 37, -122, 38] },
  criteria: {
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 4, max: 8 },
    includeUncertainAccess: true,
  },
};

const input: RouteSolverWorkerInput = {
  criteria: request.criteria,
  installationId: "fixture-installation",
  accessFilter: {
    predicates: [],
    coverage: { type: "Polygon", coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] },
  },
};

describe("RouteSolverProcess", () => {
  it("uses the production child and SQLite data for per-start searches", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alpine-compute-"));
    let session: RouteSolverProcess | undefined;
    try {
      const { installation, manifest } = await preparedInstallation(root);
      session = await RouteSolverProcess.open({
        installationId: installation.id,
        criteria: { ...request.criteria, distanceMiles: { min: 0.1, max: 20 } },
        accessFilter: { predicates: [drawnArea(manifest.coverage.bbox)], coverage: manifest.coverage.boundary },
      }, new AbortController().signal, { env: { ALPINE_COVERAGE_ROOT: root } });
      const signal = new AbortController().signal;
      const starts = await session.enumerateEligibleAccessPointIds(signal);
      expect(starts.length).toBeGreaterThan(0);
      const response = await session.searchAccessPoint(starts[0]!, signal);
      expect(response.exact.length).toBeGreaterThan(0);
      expect(response.exact.length).toBeLessThanOrEqual(10);
      expect(response.exact.every((route) => generatedClosedRouteV3Schema.safeParse(route).success)).toBe(true);
      expect(response.exact.every((route) => route.startAccessPoint.id === starts[0])).toBe(true);
      await expect(session.searchAccessPoint("missing", signal)).rejects.toMatchObject({ code: "START_INELIGIBLE" });
    } finally {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overlaps synchronous CPU work in distinct child processes", async () => {
    const signal = new AbortController().signal;
    const sessions = await Promise.all(Array.from({ length: 2 }, () => RouteSolverProcess.open(input, signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-solver-fixture-child.ts"),
      env: { ALPINE_TEST_SOLVE_MS: "300" },
    })));
    try {
      const results = await Promise.all(sessions.map((session) => session.searchAccessPoint("slow-access", signal)));
      const intervals = results.map(({ diagnostics }) => diagnostics as { pid: number; startedAt: number; finishedAt: number });
      expect(new Set(intervals.map(({ pid }) => pid)).size).toBe(2);
      const overlap = Math.min(...intervals.map(({ finishedAt }) => finishedAt)) - Math.max(...intervals.map(({ startedAt }) => startedAt));
      expect(overlap).toBeGreaterThan(100);
    } finally { await Promise.all(sessions.map((session) => session.close())); }
  });

  it("boots the production child entrypoint and reports pinned installation initialization errors", async () => {
    await expect(RouteSolverProcess.open({
      ...input,
      installationId: "definitely-missing-installation",
    }, new AbortController().signal)).rejects.toThrow("pinned installation could not be opened");
  });

  it("keeps the API responsive and cancels a synchronous search", async () => {
    const session = await RouteSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-solver-fixture-child.ts"),
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
    const session = await RouteSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-solver-fixture-child.ts"),
      env: { ALPINE_TEST_DISCONNECT: "1" },
    });

    await expect(session.searchAccessPoint("slow-access", new AbortController().signal))
      .rejects.toThrow("disconnected unexpectedly");
    await session.close();
  });

  it("terminates a child that does not acknowledge graceful close", async () => {
    const session = await RouteSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-solver-fixture-child.ts"),
      env: { ALPINE_TEST_CLOSE_HANG: "1" },
      closeTimeoutMs: 25,
    });

    await expect(session.close()).rejects.toThrow("did not close within 25 ms");
    await session.close();
  });
});
