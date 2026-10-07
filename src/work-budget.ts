import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

export type WorkBudget = { checkpoint(): Promise<void> };

/** Cooperatively budget CPU time to a fraction of one core. Checkpoints must
 * surround bounded units of synchronous work; this cannot preempt a long call.
 * Idle time repays debt but never accumulates credit for a later CPU burst. */
export function createWorkBudget({ cpuFraction = 0.4 }: { cpuFraction?: number } = {}): WorkBudget {
  if (!Number.isFinite(cpuFraction) || cpuFraction <= 0 || cpuFraction > 1) {
    throw new Error('CPU fraction must be greater than zero and at most one');
  }
  const usage = typeof process.threadCpuUsage === 'function'
    ? () => process.threadCpuUsage() : () => process.cpuUsage();
  let previous = usage(), sampledAt = performance.now(), debt = 0;
  return {
    async checkpoint() {
      const now = performance.now(), elapsed = now - sampledAt;
      if (elapsed < 8) return;
      const current = usage();
      const cpuMs = (current.user - previous.user + current.system - previous.system) / 1000;
      debt = Math.max(0, debt + cpuMs / cpuFraction - elapsed);
      previous = current; sampledAt = now;
      // Bound any one wait so cancellation and other worker events stay prompt.
      // Outstanding debt carries into the next checkpoint rather than being lost.
      await sleep(Math.min(40, Math.ceil(debt)));
    },
  };
}
