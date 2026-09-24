import { describe, expect, it } from "vitest";
import { CoverageResourceGuard, processTreeRss, type CoverageResourceSample } from "./resources";

describe("coverage resource measurements", () => {
  it("counts only the current process tree", () => {
    expect(processTreeRss("10 1 100\n11 10 200\n12 11 300\n13 1 900\n", 10)).toBe(600 * 1024);
  });

  it("reports a sampled peak and stops at the next bounded checkpoint", async () => {
    let bytes = 40;
    const probe = async (_paths: readonly string[], disk: boolean): Promise<CoverageResourceSample> => ({
      at: "2026-09-24T00:00:00Z", processTreeRssBytes: bytes, cgroupMemoryBytes: null, cgroupPeakBytes: null,
      measuredMemoryBytes: bytes, diskBytes: disk ? 100 : null,
    });
    const guard = new CoverageResourceGuard({ memoryLimitBytes: 50, diskPaths: ["/tmp/stage"], probe });
    guard.start();
    expect((await guard.checkpoint()).measuredMemoryBytes).toBe(40);
    bytes = 60;
    expect((await guard.sample("prepared")).diskBytes).toBe(100);
    await expect(guard.checkpoint()).rejects.toThrow("resource target exceeded");
    await guard.stop();
    expect(guard.peakMemoryBytes).toBe(60);
  });
});
