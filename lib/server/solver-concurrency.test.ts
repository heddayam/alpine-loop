import { afterEach, describe, expect, it, vi } from "vitest";
import { parallelMap, solverWorkerCount } from "./solver-concurrency";

vi.mock("node:os", () => ({ availableParallelism: () => 4 }));
afterEach(() => vi.unstubAllEnvs());

describe("solver concurrency", () => {
  it.each([[undefined, 2], ["1", 1], ["3", 3], ["20", 4], ["0", 2], ["1.5", 2], ["invalid", 2]])(
    "bounds the configured worker count %s to %s", (configured, expected) => {
      vi.stubEnv("ALPINE_SOLVER_WORKERS", configured);
      expect(solverWorkerCount()).toBe(expected);
    },
  );

  it("limits concurrent work and returns input order after reversed completion", async () => {
    const releases = new Map<number, () => void>();
    const started: number[] = [];
    const work = parallelMap([0, 1, 2], 2, async (item) => {
      started.push(item);
      await new Promise<void>((resolve) => releases.set(item, resolve));
      return item;
    });
    expect(started).toEqual([0, 1]);
    releases.get(1)!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases.get(2)!();
    releases.get(0)!();
    expect(await work).toEqual([0, 1, 2]);
  });

  it("drains in-flight cleanup and stops scheduling after failure", async () => {
    let release!: () => void;
    const started: number[] = [];
    let drained = false;
    const failure = new Error("cancelled");
    const work = parallelMap([0, 1, 2], 2, async (item) => {
      started.push(item);
      if (item === 0) throw failure;
      await new Promise<void>((resolve) => { release = resolve; });
      drained = true;
    });
    const rejection = expect(work).rejects.toBe(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);
    expect(drained).toBe(false);
    release();
    await rejection;
    expect(drained).toBe(true);
    expect(started).toEqual([0, 1]);
  });
});
