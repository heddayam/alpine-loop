import type { Clock } from "./types";

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  }),
};
