import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkBudget } from '../../src/work-budget.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function clock() {
  let wall = 0, cpu = 0;
  const waits: number[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => wall);
  vi.spyOn(process, 'threadCpuUsage').mockImplementation(() => ({ user: cpu * 1000, system: 0 }));
  vi.mocked(sleep).mockImplementation(async delay => { waits.push(delay!); wall += delay!; });
  return { waits, work: (ms: number) => { cpu += ms; wall += ms; }, idle: (ms: number) => { wall += ms; } };
}

it('budgets thread CPU across repeated checkpoints and does not bank idle credit', async () => {
  const time = clock(), budget = createWorkBudget();
  time.work(8); await budget.checkpoint();
  time.work(8); await budget.checkpoint();
  expect(time.waits).toEqual([12, 12]);
  time.idle(1000); await budget.checkpoint();
  time.work(8); await budget.checkpoint();
  expect(time.waits).toEqual([12, 12, 0, 12]);
});

it('repays debt from a long synchronous call through bounded waits', async () => {
  const time = clock(), budget = createWorkBudget();
  time.work(100);
  for (let turn = 0; turn < 5; turn++) await budget.checkpoint();
  expect(time.waits).toEqual([40, 40, 40, 30, 0]);
});

it('falls back to process CPU accounting when thread accounting is unavailable', async () => {
  const time = clock();
  vi.spyOn(process, 'threadCpuUsage').mockRestore();
  const threadUsage = process.threadCpuUsage;
  process.threadCpuUsage = undefined as unknown as typeof threadUsage;
  try {
    const usage = vi.spyOn(process, 'cpuUsage').mockReturnValueOnce({ user: 0, system: 0 }).mockReturnValue({ user: 8000, system: 0 });
    const budget = createWorkBudget();
    time.idle(8); await budget.checkpoint();
    expect(usage).toHaveBeenCalledTimes(2);
    expect(time.waits).toEqual([12]);
  } finally { process.threadCpuUsage = threadUsage; }
});

it('rejects nonsensical CPU fractions', () => {
  for (const cpuFraction of [0, -1, 1.1, NaN, Infinity]) expect(() => createWorkBudget({ cpuFraction })).toThrow(/CPU fraction/);
});
