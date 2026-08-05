import { defaultReachabilityService } from "@/lib/reachability/default-service";
import { createGeocodingSuggestHandler } from "@/lib/reachability/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createGeocodingSuggestHandler(defaultReachabilityService());
