import type {
  Origin,
  ReachabilityRequest,
  ReachabilityResponse,
} from "@/lib/contracts";
import { ReachabilityError, toReachabilityError } from "./errors";
import { MemoryReachabilityJobStore } from "./jobs";
import type {
  ArcGisProvider,
  Clock,
  GeocodingSuggestion,
  IdGenerator,
} from "./types";
import {
  ARCGIS_GEOCODING_MONTHLY_LIMIT,
  ARCGIS_GEOCODING_PROVIDER,
  ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
  ARCGIS_SERVICE_AREA_PROVIDER,
  type UsageStore,
} from "./usage";

type ReachabilityServiceOptions = {
  provider: ArcGisProvider;
  usage: UsageStore;
  jobs: MemoryReachabilityJobStore;
  clock: Clock;
  id: IdGenerator;
  geocodingMonthlyLimit?: number;
  serviceAreaMonthlyLimit?: number;
};

export class ReachabilityService {
  private readonly provider: ArcGisProvider;
  private readonly usage: UsageStore;
  private readonly jobs: MemoryReachabilityJobStore;
  private readonly clock: Clock;
  private readonly id: IdGenerator;
  private readonly geocodingMonthlyLimit: number;
  private readonly serviceAreaMonthlyLimit: number;

  constructor(options: ReachabilityServiceOptions) {
    this.provider = options.provider;
    this.usage = options.usage;
    this.jobs = options.jobs;
    this.clock = options.clock;
    this.id = options.id;
    this.geocodingMonthlyLimit = options.geocodingMonthlyLimit ?? ARCGIS_GEOCODING_MONTHLY_LIMIT;
    this.serviceAreaMonthlyLimit = options.serviceAreaMonthlyLimit ?? ARCGIS_SERVICE_AREA_MONTHLY_LIMIT;
  }

  private async reserve(provider: string, limit: number): Promise<void> {
    let reservation;
    try {
      reservation = await this.usage.reserve(provider, limit, this.clock.now());
    } catch {
      throw new ReachabilityError(
        "USAGE_UNAVAILABLE",
        "Provider usage could not be verified, so the request was blocked.",
        503,
      );
    }
    if (!reservation) {
      throw new ReachabilityError(
        "USAGE_LIMIT_REACHED",
        "The monthly ArcGIS safety limit has been reached.",
        429,
        false,
        { provider, period: this.clock.now().toISOString().slice(0, 7), limit },
      );
    }
  }

  async suggest(text: string, signal?: AbortSignal): Promise<GeocodingSuggestion[]> {
    await this.reserve(ARCGIS_GEOCODING_PROVIDER, this.geocodingMonthlyLimit);
    return this.provider.suggest(text, signal);
  }

  async resolve(text: string, magicKey: string, signal?: AbortSignal): Promise<Origin> {
    await this.reserve(ARCGIS_GEOCODING_PROVIDER, this.geocodingMonthlyLimit);
    return this.provider.resolve(text, magicKey, signal);
  }

  async submit(request: ReachabilityRequest, signal?: AbortSignal): Promise<ReachabilityResponse> {
    const reusable = this.jobs.findReusable(request);
    if (reusable) return this.response(reusable.id);

    const id = this.id();
    this.jobs.create(id, request);
    try {
      await this.reserve(ARCGIS_SERVICE_AREA_PROVIDER, this.serviceAreaMonthlyLimit);
      const providerJobId = await this.provider.submitServiceArea(request, signal);
      this.jobs.update(id, { providerJobId, state: "pending" });
      return { status: "pending", requestId: id, pollAfterMs: 1_000 };
    } catch (error) {
      const normalized = toReachabilityError(error);
      this.jobs.delete(id);
      throw normalized;
    }
  }

  async poll(id: string, signal?: AbortSignal): Promise<ReachabilityResponse> {
    const lookup = this.jobs.lookup(id);
    if (lookup.state === "expired") {
      throw new ReachabilityError(
        "REACHABILITY_EXPIRED",
        "That drive-time request expired. Calculate it again.",
        410,
      );
    }
    if (lookup.state === "missing") {
      throw new ReachabilityError(
        "REACHABILITY_NOT_FOUND",
        "That drive-time request was not found.",
        404,
      );
    }
    const { job } = lookup;
    if (job.state === "complete" || job.state === "failed" || !job.providerJobId) {
      return this.response(id);
    }

    const result = await this.provider.pollServiceArea(job.providerJobId, signal);
    if (result.state === "pending") {
      return { status: "pending", requestId: id, pollAfterMs: 1_000 };
    }
    if (result.state === "failed") {
      this.jobs.update(id, { state: "failed", error: result.message });
      throw new ReachabilityError("REACHABILITY_FAILED", result.message, 502);
    }
    this.jobs.update(id, {
      state: "complete",
      geometry: result.geometry,
      resolvedAt: this.clock.now(),
    });
    return this.response(id);
  }

  async cancel(id: string, signal?: AbortSignal): Promise<void> {
    const lookup = this.jobs.lookup(id);
    if (lookup.state === "expired") {
      throw new ReachabilityError("REACHABILITY_EXPIRED", "That drive-time request expired.", 410);
    }
    if (lookup.state === "missing") {
      throw new ReachabilityError("REACHABILITY_NOT_FOUND", "That drive-time request was not found.", 404);
    }
    const { job } = lookup;
    if (job.providerJobId && job.state === "pending") {
      await this.provider.cancelServiceArea(job.providerJobId, signal);
    }
    this.jobs.delete(id);
  }

  private response(id: string): ReachabilityResponse {
    const lookup = this.jobs.lookup(id);
    if (lookup.state !== "found") {
      throw new ReachabilityError("REACHABILITY_NOT_FOUND", "That drive-time request was not found.", 404);
    }
    const { job } = lookup;
    if (job.state === "failed") {
      throw new ReachabilityError(
        "REACHABILITY_FAILED",
        job.error ?? "The drive-time calculation failed.",
        502,
      );
    }
    if (job.state !== "complete" || !job.geometry || !job.resolvedAt) {
      return { status: "pending", requestId: id, pollAfterMs: 1_000 };
    }
    return {
      status: "complete",
      requestId: id,
      provider: "arcgis",
      durationMinutes: job.durationMinutes,
      resolvedAt: job.resolvedAt.toISOString(),
      geometry: job.geometry,
    };
  }
}
