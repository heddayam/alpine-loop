import { availableParallelism } from "node:os";

/** Each worker owns a graph cache; keep the memory-sensitive default small. */
export function solverWorkerCount(): number {
  const configured = Number(process.env.ALPINE_SOLVER_WORKERS ?? 2);
  const requested = Number.isSafeInteger(configured) && configured > 0 ? configured : 2;
  return Math.max(1, Math.min(8, availableParallelism(), requested));
}

/** Start bounded independent work, retain input ordering, and drain on failure. */
export async function parallelMap<T, R>(items: readonly T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index]!); }
      catch (error) { failed = true; throw error; }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}
