import type { Origin, ReachabilityRequest } from "@/lib/contracts";
import type { AreaGeometry, Clock } from "./types";

export const REACHABILITY_JOB_TTL_MS = 30 * 60 * 1_000;
export const REACHABILITY_TOMBSTONE_TTL_MS = REACHABILITY_JOB_TTL_MS;

export type ReachabilityJob = {
  id: string;
  requestKey: string;
  packId: string;
  origin: Origin;
  durationMinutes: ReachabilityRequest["durationMinutes"];
  providerJobId?: string;
  state: "submitting" | "pending" | "complete" | "failed";
  geometry?: AreaGeometry;
  error?: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
};

export type JobLookup =
  | { state: "found"; job: ReachabilityJob }
  | { state: "expired" }
  | { state: "missing" };

export function reachabilityRequestKey(request: ReachabilityRequest): string {
  return [
    request.packId,
    request.origin.lat.toFixed(5),
    request.origin.lon.toFixed(5),
    request.durationMinutes,
  ].join(":");
}

/**
 * Location-bearing state is intentionally process-local. Expiry replaces a job
 * with an identifier-only tombstone so callers can distinguish expiry without
 * retaining the origin, label, or contour.
 */
export class MemoryReachabilityJobStore {
  private readonly jobs = new Map<string, ReachabilityJob>();
  private readonly byRequest = new Map<string, string>();
  private readonly expiredIds = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  private expire(): void {
    const now = this.clock.now().getTime();
    for (const [id, expiresAt] of this.expiredIds) {
      if (expiresAt <= now) this.expiredIds.delete(id);
    }
    for (const [id, job] of this.jobs) {
      if (job.expiresAt.getTime() > now) continue;
      this.jobs.delete(id);
      if (this.byRequest.get(job.requestKey) === id) this.byRequest.delete(job.requestKey);
      this.expiredIds.set(id, now + REACHABILITY_TOMBSTONE_TTL_MS);
    }
  }

  create(id: string, request: ReachabilityRequest): ReachabilityJob {
    this.expire();
    this.expiredIds.delete(id);
    const now = this.clock.now();
    const job: ReachabilityJob = {
      id,
      requestKey: reachabilityRequestKey(request),
      packId: request.packId,
      origin: structuredClone(request.origin),
      durationMinutes: request.durationMinutes,
      state: "submitting",
      createdAt: now,
      expiresAt: new Date(now.getTime() + REACHABILITY_JOB_TTL_MS),
    };
    this.jobs.set(id, job);
    this.byRequest.set(job.requestKey, id);
    return job;
  }

  findReusable(request: ReachabilityRequest): ReachabilityJob | undefined {
    this.expire();
    const id = this.byRequest.get(reachabilityRequestKey(request));
    if (!id) return undefined;
    const job = this.jobs.get(id);
    return job?.state === "failed" ? undefined : job;
  }

  lookup(id: string): JobLookup {
    this.expire();
    const job = this.jobs.get(id);
    if (job) return { state: "found", job };
    return this.expiredIds.has(id) ? { state: "expired" } : { state: "missing" };
  }

  update(id: string, update: Partial<Pick<
    ReachabilityJob,
    "providerJobId" | "state" | "geometry" | "error" | "resolvedAt"
  >>): ReachabilityJob | undefined {
    const lookup = this.lookup(id);
    if (lookup.state !== "found") return undefined;
    Object.assign(lookup.job, update);
    return lookup.job;
  }

  delete(id: string): ReachabilityJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    this.jobs.delete(id);
    if (this.byRequest.get(job.requestKey) === id) this.byRequest.delete(job.requestKey);
    return job;
  }
}
