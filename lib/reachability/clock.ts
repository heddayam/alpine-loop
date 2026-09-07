import type { Clock } from "./types";

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const aborted = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  }),
};
