import { vi } from "vitest";
import type { Clock } from "./types";
import type { UsageReservation, UsageStore } from "./usage";

export class TestClock implements Clock {
  readonly sleeps: number[] = [];

  constructor(private current = new Date("2026-08-04T12:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: string): void {
    this.current = new Date(value);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.sleeps.push(milliseconds);
  }
}

export class TestUsageStore implements UsageStore {
  readonly reserve = vi.fn(async (
    provider: string,
    limit: number,
    now: Date,
  ): Promise<UsageReservation | null> => ({
    provider,
    period: now.toISOString().slice(0, 7),
    limit,
    used: 1,
    remaining: limit - 1,
  }));

  readonly get = vi.fn(async (
    provider: string,
    limit: number,
    now: Date,
  ): Promise<UsageReservation> => ({
    provider,
    period: now.toISOString().slice(0, 7),
    limit,
    used: 0,
    remaining: limit,
  }));
}
