import type { Origin } from "@/lib/contracts";
import { cancelledError, ReachabilityError, toReachabilityError } from "./errors";
import type { ArcGisProvider, AreaGeometry, Clock, DriveTimeAreaRequest, GeocodingSuggestion } from "./types";
import {
  ARCGIS_GEOCODING_MONTHLY_LIMIT,
  ARCGIS_GEOCODING_PROVIDER,
  ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
  ARCGIS_SERVICE_AREA_PROVIDER,
  type UsageStore,
} from "./usage";

export const DRIVE_TIME_AREA_TTL_MS = 30 * 60 * 1_000;
export const DRIVE_TIME_AREA_DEADLINE_MS = 120_000;

type ReachabilityServiceOptions = {
  provider: ArcGisProvider;
  usage: UsageStore;
  clock: Clock;
  geocodingMonthlyLimit?: number;
  serviceAreaMonthlyLimit?: number;
};

export type CompletedReachability = {
  geometry: AreaGeometry;
  durationMinutes: DriveTimeAreaRequest["durationMinutes"];
  resolvedAt: string;
  originLabel: string;
};

export class ReachabilityService {
  private readonly provider: ArcGisProvider;
  private readonly usage: UsageStore;
  private readonly clock: Clock;
  private readonly geocodingMonthlyLimit: number;
  private readonly serviceAreaMonthlyLimit: number;
  private readonly areas = new Map<string, { geometry: AreaGeometry; resolvedAt: string; expiresAt: number }>();

  constructor(options: ReachabilityServiceOptions) {
    this.provider = options.provider;
    this.usage = options.usage;
    this.clock = options.clock;
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

  /** Resolves typical drive time, reusing only completed process-local geometry. */
  async resolveArea(request: DriveTimeAreaRequest, signal: AbortSignal): Promise<CompletedReachability> {
    if (signal.aborted) throw cancelledError();
    const now = this.clock.now().getTime();
    for (const [key, area] of this.areas) {
      if (area.expiresAt <= now) this.areas.delete(key);
    }
    const key = JSON.stringify([request.origin.lon, request.origin.lat, request.durationMinutes]);
    const cached = this.areas.get(key);
    if (cached) return {
      geometry: structuredClone(cached.geometry),
      resolvedAt: cached.resolvedAt,
      durationMinutes: request.durationMinutes,
      originLabel: request.origin.label,
    };

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new ReachabilityError(
      "REACHABILITY_FAILED", "The drive-time calculation exceeded its two-minute limit.", 504, true,
    )), DRIVE_TIME_AREA_DEADLINE_MS);
    const active = AbortSignal.any([signal, deadline.signal]);
    let rejectAborted: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(active.reason);
      active.addEventListener("abort", rejectAborted, { once: true });
    });
    let providerJobId: string | undefined;
    const cancel = () => {
      if (!providerJobId) return;
      const id = providerJobId;
      providerJobId = undefined;
      // No work is shared. Cancellation must never delay the caller's failure.
      void this.provider.cancelServiceArea(id, AbortSignal.timeout(1_000)).catch(() => undefined);
    };
    const resolve = async (): Promise<CompletedReachability> => {
      let completed = false;
      try {
        active.throwIfAborted();
        await this.reserve(ARCGIS_SERVICE_AREA_PROVIDER, this.serviceAreaMonthlyLimit);
        active.throwIfAborted();
        providerJobId = await this.provider.submitServiceArea(request, active);
        for (;;) {
          active.throwIfAborted();
          const result = await this.provider.pollServiceArea(providerJobId, active);
          active.throwIfAborted();
          if (result.state === "failed") throw new ReachabilityError("REACHABILITY_FAILED", result.message, 502);
          if (result.state === "complete") {
            const resolvedAt = this.clock.now();
            this.areas.set(key, {
              geometry: structuredClone(result.geometry),
              resolvedAt: resolvedAt.toISOString(),
              expiresAt: resolvedAt.getTime() + DRIVE_TIME_AREA_TTL_MS,
            });
            completed = true;
            return {
              geometry: result.geometry,
              resolvedAt: resolvedAt.toISOString(),
              durationMinutes: request.durationMinutes,
              originLabel: request.origin.label,
            };
          }
          await this.clock.sleep(1_000, active);
        }
      } finally {
        if (!completed) cancel();
      }
    };
    try {
      return await Promise.race([resolve(), aborted]);
    } catch (error) {
      cancel();
      throw signal.aborted ? cancelledError() : toReachabilityError(error);
    } finally {
      clearTimeout(timer);
      active.removeEventListener("abort", rejectAborted!);
    }
  }
}
