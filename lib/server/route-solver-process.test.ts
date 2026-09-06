import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { compilePack } from "@/lib/data/compiler";
import { fixtureCompileOptionsV6 } from "@/lib/data/fixture-pack";
import { generateClosedRoutesResponseV3Schema, packManifestV6Schema } from "@/lib/contracts";
import { CLOSED_ROUTE_EFFORT_BUDGETS } from "@/lib/solver";
import { resolvedDrawnAreaAccessFilter } from "./access-filter";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CreateBatchRouteJobV1 } from "@/lib/contracts";
import { RouteSolverProcess } from "./route-solver-process";
import type { RouteSolverWorkerInput } from "./route-solver-protocol";

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

const input: RouteSolverWorkerInput = {
  criteria: request.criteria,
  pack: { id: "fixture-pack", dataVersion: "v4" },
  accessFilter: {
    summary: { mode: "drawn-area", label: "Drawn area" },
    predicates: [],
    coverage: { type: "Polygon", coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] },
  },
};

describe("RouteSolverProcess", () => {
  it("uses the production child and SQLite data for foreground and per-start searches", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alpine-compute-"));
    let session: RouteSolverProcess | undefined;
    try {
      const artifact = await compilePack(await fixtureCompileOptionsV6(root));
      const manifest = packManifestV6Schema.parse(JSON.parse(await readFile(artifact.manifestPath, "utf8")));
      session = await RouteSolverProcess.open({
        pack: manifest,
        criteria: { ...request.criteria, distanceMiles: { min: 0.1, max: 20 } },
        accessFilter: resolvedDrawnAreaAccessFilter({ coverage: manifest.coverage.boundary }, manifest.coverage.bbox),
      }, new AbortController().signal, { env: { ALPINE_PACK_ROOT: root } });
      const signal = new AbortController().signal;
      const response = generateClosedRoutesResponseV3Schema.parse(await session.generate(
        { searchEffort: "quick", limit: 2 }, CLOSED_ROUTE_EFFORT_BUDGETS.quick, signal,
      ));
      expect(response.exact.length).toBeGreaterThan(0);
      const starts = await session.enumerateEligibleAccessPointIds(signal);
      expect(starts).toContain(response.exact[0]!.startAccessPoint.id);
      const full = await session.searchAccessPoint(response.exact[0]!.startAccessPoint.id, signal);
      const perStart = await session.generate({ searchEffort: "quick", limit: 10,
        startAccessPointId: response.exact[0]!.startAccessPoint.id }, CLOSED_ROUTE_EFFORT_BUDGETS.quick, signal);
      expect(full.exact.map(({ id }) => id)).toEqual(expect.arrayContaining(perStart.exact.map(({ id }) => id)));
      await expect(session.generate({ searchEffort: "quick", limit: 1, startAccessPointId: "missing" },
        CLOSED_ROUTE_EFFORT_BUDGETS.quick, signal)).rejects.toMatchObject({ code: "START_NOT_FOUND" });
    } finally {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("boots the production child entrypoint and reports pinned-pack initialization errors", async () => {
    await expect(RouteSolverProcess.open({
      ...input,
      pack: { ...input.pack, id: "definitely-missing-worker-pack" },
    }, new AbortController().signal)).rejects.toThrow("pinned pack version is no longer installed");
  });

  it.each(["quick", "full"] as const)("keeps the API responsive and cancels a synchronous %s search", async (mode) => {
    const session = await RouteSolverProcess.open(input, new AbortController().signal, {
      modulePath: resolve(process.cwd(), "lib/server/__fixtures__/route-solver-fixture-child.ts"),
      env: { ALPINE_TEST_SOLVE_MS: "15000" },
    });
    expect(await session.enumerateEligibleAccessPointIds(new AbortController().signal)).toEqual(["slow-access"]);

    const controller = new AbortController();
    const startedAt = performance.now();
    const search = mode === "full"
      ? session.searchAccessPoint("slow-access", controller.signal)
      : session.generate({ searchEffort: "quick", limit: 1 }, {
        deadlineMs: 15_000, maximumDirectedEdges: 100, maximumExpandedStates: 100, maximumRawCandidates: 10,
      }, controller.signal);
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
