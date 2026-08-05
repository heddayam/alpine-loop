import { resolve } from "node:path";
import { ArcGisClient } from "./arcgis";
import { systemClock } from "./clock";
import { MemoryReachabilityJobStore } from "./jobs";
import { ReachabilityService } from "./service";
import { SqliteUsageStore } from "./usage";

declare global {
  var alpineReachabilityService: ReachabilityService | undefined;
}

export function arcGisKeys(environment: Readonly<Record<string, string | undefined>>): {
  geocodingApiKey?: string;
  routingApiKey?: string;
} {
  const fallbackKey = environment.ARCGIS_API_KEY;
  return {
    geocodingApiKey: environment.ARCGIS_GEOCODING_API_KEY ?? fallbackKey,
    routingApiKey: environment.ARCGIS_ROUTING_API_KEY ?? fallbackKey,
  };
}

function createDefaultService(): ReachabilityService {
  const keys = arcGisKeys(process.env);
  const provider = new ArcGisClient({
    fetch,
    clock: systemClock,
    ...keys,
  });
  const usagePath = process.env.ALPINE_PROVIDER_USAGE_DB
    ?? resolve(process.cwd(), ".local-data/runtime/provider-usage.sqlite");
  return new ReachabilityService({
    provider,
    usage: new SqliteUsageStore(usagePath),
    jobs: new MemoryReachabilityJobStore(systemClock),
    clock: systemClock,
    id: () => crypto.randomUUID(),
  });
}

export function defaultReachabilityService(): ReachabilityService {
  globalThis.alpineReachabilityService ??= createDefaultService();
  return globalThis.alpineReachabilityService;
}
